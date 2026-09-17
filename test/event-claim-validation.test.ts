import { getAnthropicClient } from "@/lib/claude/client";
import { mentionsEvent, validateReply } from "@/lib/claude/validate-reply";

jest.mock("@/lib/claude/client", () => ({
  ...jest.requireActual("@/lib/claude/client"),
  getAnthropicClient: jest.fn(),
  HAIKU_MODEL: "claude-haiku-4-5",
}));

/**
 * On 2026-09-17 the bot told The Breeze event lead her Rp 26.000 boxes included
 * air mineral. No tier includes it — the three packaging tiers come from the
 * QBig BSD tender and carry nasi + lauk + sayur + sambal — and honouring it
 * would have cost Rp 20.000-30.000 on 20 boxes, taking the margin from 25% to
 * about 20%. The validator passed the reply because what a box contains was
 * "general business info", which is true of the daily menu and false of an
 * event: an event's contents are whatever the kitchen bid covers, and nobody
 * had bid yet.
 */
function mockValidator() {
  const create = jest.fn().mockResolvedValue({
    content: [{ type: "text", text: '{"valid": true}' }],
    stop_reason: "end_turn",
  });
  (getAnthropicClient as jest.Mock).mockReturnValue({ messages: { create } });
  return create;
}

const BASE = {
  customerName: "Rina",
  customerNotes: null,
  customerState: "new",
  activeOrder: null,
};

beforeEach(() => jest.clearAllMocks());

describe("mentionsEvent", () => {
  it("catches the words a one-off booking arrives in", () => {
    for (const text of [
      "mau pesan untuk acara kantor",
      "butuh 20 nasi box hari Sabtu",
      "ada paket snack box?",
      "untuk pengajian ya kak",
    ]) {
      expect(mentionsEvent(text)).toBe(true);
    }
  });

  it("leaves an ordinary daily thread alone", () => {
    for (const text of [
      "mau langganan 20 porsi dong",
      "besok kirim ke kantor ya",
      "sisa kuota saya berapa?",
    ]) {
      expect(mentionsEvent(text)).toBe(false);
    }
  });
});

describe("validateReply — an event thread checks price and contents", () => {
  it("sends the event rules when the customer asked about an acara", async () => {
    const create = mockValidator();

    await validateReply({
      ...BASE,
      reply: "Baik kak, harganya Rp 26.000 per box sudah termasuk air mineral.",
      transcript: [
        { role: "user", content: "mau pesan 20 box untuk acara kantor" },
      ],
    });

    const system = create.mock.calls[0][0].system as string;
    expect(system).toMatch(/EVENT/);
    expect(system).toMatch(/air mineral/i);
    // The daily side must stay waived, or every ladder price in the thread
    // becomes an unsupported claim and the customer gets the fallback template.
    expect(system).toMatch(/daily subscription price list/i);
  });

  it("sends the event rules when the bot itself answered as an event", async () => {
    const create = mockValidator();

    await validateReply({
      ...BASE,
      reply: "Untuk acara 20 box, boxnya sudah termasuk buah ya kak.",
      transcript: [{ role: "user", content: "bisa 20 box hari Sabtu?" }],
    });

    expect(create.mock.calls[0][0].system as string).toMatch(/EVENT/);
  });

  it("leaves a daily thread on the ordinary rules", async () => {
    const create = mockValidator();

    await validateReply({
      ...BASE,
      reply: "Paket 20 porsi → 20 × Rp 26.000 = Rp 520.000 ya kak.",
      transcript: [{ role: "user", content: "mau langganan 20 porsi" }],
    });

    expect(create.mock.calls[0][0].system as string).not.toMatch(/EVENT/);
  });
});
