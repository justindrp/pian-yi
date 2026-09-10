import { readPaymentSlip, slipMatchesTotals } from "@/lib/claude/vision";

const create = jest.fn();

jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: () => ({ messages: { create } }),
  HAIKU_MODEL: "x",
  NO_THINKING: {},
  extractText: (res: { content: { type: string; text?: string }[] }) =>
    res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim(),
  extractJson: jest.fn(),
}));

// The helper compresses before it asks, and sharp is not what is under test.
jest.mock("@/lib/images/compress", () => ({
  compressUploadedImage: async (input: Buffer) => ({
    buffer: input,
    contentType: "image/jpeg",
    extension: "jpg",
  }),
}));

function reply(text: string) {
  return { content: [{ type: "text", text }] };
}

const IMAGE = Buffer.from("not-really-a-jpeg");

beforeEach(() => {
  create.mockReset();
});

describe("slipMatchesTotals", () => {
  it("matches a single order total", () => {
    expect(slipMatchesTotals(145000, [145000])).toBe(true);
  });

  // Measured on real proofs: one image read 685.000 against orders of 540.000
  // and 145.000. The transfer covered both, so the read was right and only the
  // per-order comparison was wrong.
  it("matches the sum when one transfer covers two orders", () => {
    expect(slipMatchesTotals(685000, [540000, 145000])).toBe(true);
  });

  it("still matches either total on its own", () => {
    expect(slipMatchesTotals(540000, [540000, 145000])).toBe(true);
  });

  it("is false for a figure that is neither", () => {
    expect(slipMatchesTotals(100000, [600000])).toBe(false);
  });

  // No verdict is not the same as a contradiction. An unreadable figure must
  // not render as "beda dari total order".
  it("gives no verdict when the amount did not read", () => {
    expect(slipMatchesTotals(null, [145000])).toBeNull();
  });

  it("gives no verdict when there are no orders to compare against", () => {
    expect(slipMatchesTotals(145000, [])).toBeNull();
  });
});

describe("readPaymentSlip", () => {
  it("reads a plain JSON answer", async () => {
    create.mockResolvedValue(
      reply(
        '{"is_transfer_receipt":true,"amount_idr":145000,"recipient_name":"DANIEL RAHARDYAN PRAMADY","bank":"BCA","datetime":"29/08/2026 14:42:24"}',
      ),
    );
    await expect(readPaymentSlip(IMAGE)).resolves.toEqual({
      isTransferReceipt: true,
      amountIdr: 145000,
      recipientName: "DANIEL RAHARDYAN PRAMADY",
      bank: "BCA",
      datetime: "29/08/2026 14:42:24",
    });
  });

  it("unwraps a fenced answer", async () => {
    create.mockResolvedValue(
      reply('```json\n{"is_transfer_receipt":true,"amount_idr":174000}\n```'),
    );
    const read = await readPaymentSlip(IMAGE);
    expect(read?.amountIdr).toBe(174000);
    expect(read?.recipientName).toBeNull();
  });

  // A thousand-separator misread put one slip in 36 at 145000000 for a 145.000
  // transfer. Showing an admin a figure that large as if it had been read is
  // worse than showing none.
  it("drops an out-of-range figure rather than reporting it", async () => {
    create.mockResolvedValue(
      reply('{"is_transfer_receipt":true,"amount_idr":145000000}'),
    );
    const read = await readPaymentSlip(IMAGE);
    expect(read?.amountIdr).toBeNull();
  });

  it("drops a zero or negative figure", async () => {
    create.mockResolvedValue(reply('{"amount_idr":0}'));
    expect((await readPaymentSlip(IMAGE))?.amountIdr).toBeNull();
  });

  it("returns null when the answer will not parse", async () => {
    create.mockResolvedValue(reply("maaf saya tidak bisa membaca gambar ini"));
    await expect(readPaymentSlip(IMAGE)).resolves.toBeNull();
  });

  // The proof is banked before this runs, so an outage costs the pre-read and
  // nothing else. It must never throw into the webhook.
  it("returns null when the model call fails", async () => {
    create.mockRejectedValue(new Error("502 upstream"));
    await expect(readPaymentSlip(IMAGE)).resolves.toBeNull();
  });

  it("reports a non-receipt image as such", async () => {
    create.mockResolvedValue(
      reply('{"is_transfer_receipt":false,"amount_idr":null}'),
    );
    const read = await readPaymentSlip(IMAGE);
    expect(read?.isTransferReceipt).toBe(false);
    expect(read?.amountIdr).toBeNull();
  });
});
