import { getActiveInstructions, getSetting } from "@/lib/cache/settings";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";

jest.mock("@/lib/cache/settings", () => ({
  getActiveInstructions: jest.fn(),
  getSetting: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (getActiveInstructions as jest.Mock).mockResolvedValue([]);
  (getSetting as jest.Mock).mockImplementation((key: string) => {
    const values: Record<string, string> = {
      business_name: "Pian Yi Catering",
      bank_name: "BCA",
      bank_account_number: "123",
      bank_account_name: "Pian Yi",
      escalation_keywords: "[]",
      order_deadline_hour: "20",
      order_deadline_daily_hour: "20",
    };
    return Promise.resolve(values[key] ?? "");
  });
});

describe("customer chatbot system prompt", () => {
  test("uses new S-only personal package price list", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    });

    expect(prompt).toContain("Only size S is available");
    expect(prompt).toContain("- 5 hari siang/malam saja: Rp 145.000");
    expect(prompt).toContain("- 72 hari siang + malam: Rp 3.600.000");
    expect(prompt).toContain("Dapur kami delivers Senin–Sabtu");
    // 5 and 6 days are the commonest weekly shapes, never the permitted set.
    // Phrased as an availability list, the model read it as a closed menu and
    // refused a 7-day run outright — see "5 and 6 days are the common weeks"
    // in docs/BOT_RULES.md. The ladder prices total portions, not days.
    expect(prompt).toContain("NOT the only ones we sell");
    expect(prompt).toContain(
      "Never tell a customer we only offer 5- or 6-day packages",
    );
    expect(prompt).not.toContain("Fixed weekly orders are available 5 days");
    expect(prompt).not.toContain("M (+Rp 2.000/porsi)");
    expect(prompt).not.toContain("Mau ukuran S");
  });

  test("prices off-list totals at the tier below, not as repeated packages", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    });

    expect(prompt).toContain("is a multiple of 5 or of 6");
    expect(prompt).toContain(
      "15 porsi → largest listed size below 15 is 12 → Rp 28.000/porsi → 15 × Rp 28.000 = *Rp 420.000*",
    );
    expect(prompt).toContain(
      "25 porsi → largest listed size below 25 is 24 → Rp 27.000/porsi → 25 × Rp 27.000 = *Rp 675.000*",
    );
    expect(prompt).toContain(
      "Never build the price out of repeated smaller packages",
    );
    expect(prompt).toContain(
      "neither on the list nor a multiple of 5 or of 6: reject it",
    );
    // The block-pricing rule this replaced must not come back — it charged the
    // small-package rate on large orders, so 25 porsi cost more than 24.
    expect(prompt).not.toContain("Rp 435.000");
  });

  // The turn that follows the welcome sequence: 153 of the first 223 welcomed
  // customers got one. Everything has just been sent and the rules forbid
  // repeating any of it, so without a job the model fills the hole — an ad
  // lead on 2026-08-27 got "Aku cek dulu bentar ya kak" and nothing after,
  // because no second turn is ever scheduled. See docs/BOT_RULES.md.
  // "Area never blocks the order" was written for a cluster inside coverage the
  // bot did not recognise — Janice's "Pagedangan" was asked about four times
  // running. It had no floor, so an address in another kabupaten took the same
  // path: Sarah Sinaga gave Gunung Sindur, Kab. Bogor on 2026-08-30, the word
  // "Serpong" in her cluster name was enough, and she was quoted Rp 1.040.000
  // for 40 portions to an address no kitchen can reach.
  test("stops nearest-area rounding at the edge of coverage", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    });
    expect(prompt).toContain("different kota or kabupaten");
    expect(prompt).toContain("do not call extract_order");
    // The old rule stays for the case it was written for.
    expect(prompt).toContain("Area never blocks the order");
    expect(prompt).toContain(
      "check the address is reachable before you quote",
    );
  });

  // The kabupaten rule above assumed the address arrives as words. Sarah
  // Sinaga's second one did not: told her home was out of coverage, she sent a
  // bare maps pin for her office. The model cannot open a link, so it filled
  // `area` with "BSD Baru", wrote the address as "Alamat kantor sesuai titik
  // Google Maps yang dikirim", quoted Rp 336.000 and sent the bank details —
  // for an office that is also outside coverage. The "a maps link counts as an
  // address given" rule is about not asking twice, never about coverage.
  test("does not let a maps link settle the area", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: "https://maps.app.goo.gl/abc",
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    });
    expect(prompt).toContain("A Google Maps link is not an address you can read");
    expect(prompt).toContain("never let a link end the area question");
    expect(prompt).toContain(
      "do not quote a price or call extract_order until they answer",
    );
    // The bullet is worthless if it leaves the old "counts as given" wording
    // reading as permission to skip the area.
    expect(prompt).toContain("it never means the area is confirmed");
  });

  describe("a renewal whose quota is exhausted", () => {
    const renewing = {
      casual: false,
      customerState: "ordering" as const,
      customerName: "Julian S",
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: {
        id: "o1",
        packageSize: 5,
        portionsPerDelivery: 1,
        pricePerPortion: 29000,
      },
      schedule: { unbooked: 0, remainingToday: 0, upcoming: [] },
    };

    // The branch gated the call ("only once they have told you the days") and
    // never fired it. Julian S renewed on 2026-08-30, gave dinner, Senin–Jumat
    // and a 31 August start, and was asked to confirm three more times before
    // the bot promised an order it never created — flagOrderAtRisk caught it as
    // an unkept promise. Everything a renewal needs is already on the record,
    // so the days arriving is the trigger, not another gate.
    test("makes the days the trigger, not one more gate", async () => {
      const prompt = await buildSystemPrompt(renewing as never);
      expect(prompt).toContain(
        "the turn they arrive is the turn that calls extract_order",
      );
      expect(prompt).toContain("sudah benar semua kan kak?");
      expect(prompt).toContain("saya buatkan ordernya sekarang ya kak");
    });

    test("says none of it while quota is left", async () => {
      const prompt = await buildSystemPrompt({
        ...renewing,
        schedule: { unbooked: 3, remainingToday: 3, upcoming: [] },
      } as never);
      expect(prompt).not.toContain(
        "the turn they arrive is the turn that calls extract_order",
      );
    });
  });

  describe("the turn right after the welcome sequence", () => {
    const base = {
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    };

    test("gives that turn one question to ask", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        casual: false,
        justWelcomed: true,
      });

      expect(prompt).toContain("This is your first reply to this customer");
      expect(prompt).toContain("one question that moves the order forward");
      expect(prompt).toContain("Never stall");
      expect(prompt).toContain("Aku cek dulu");
    });

    // The stall is what casual mode produced, so the block is worthless if
    // casual mode is what drops it.
    test("applies in casual mode too", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        casual: true,
        justWelcomed: true,
      });

      expect(prompt).toContain("This is your first reply to this customer");
      expect(prompt).toContain("Casual changes the wording, never the job");
    });

    test("says nothing on every other turn", async () => {
      const prompt = await buildSystemPrompt({ ...base, casual: false });

      expect(prompt).not.toContain("This is your first reply to this customer");
    });
  });
});
