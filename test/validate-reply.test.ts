import { getAnthropicClient } from "@/lib/claude/client";
import { validateReply } from "@/lib/claude/validate-reply";

jest.mock("@/lib/claude/client", () => ({
  ...jest.requireActual("@/lib/claude/client"),
  getAnthropicClient: jest.fn(),
  HAIKU_MODEL: "claude-haiku-4-5",
}));

jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(async (key: string) =>
    key === "team_roster" ? "Justin — owner\nJennifer — asisten Justin" : "",
  ),
}));

function mockCreate(response: unknown) {
  (getAnthropicClient as jest.Mock).mockReturnValue({
    messages: { create: jest.fn().mockResolvedValue(response) },
  });
}

const baseParams = {
  reply: "Halo kak!",
  customerName: null,
  customerNotes: null,
  customerState: "new",
  activeOrder: null,
};

describe("validateReply", () => {
  test("valid reply returns valid: true", async () => {
    mockCreate({ content: [{ type: "text", text: '{"valid": true}' }] });

    const result = await validateReply(baseParams);

    expect(result).toEqual({ valid: true, unsupportedClaims: [] });
  });

  test("unsupported claim returns valid: false with claims", async () => {
    mockCreate({
      content: [
        {
          type: "text",
          text: '{"valid": false, "unsupported_claims": [{"field": "quota", "claim": "kuota kakak masih 10 porsi"}]}',
        },
      ],
    });

    const result = await validateReply({
      ...baseParams,
      reply: "Kuota kakak masih 10 porsi ya",
    });

    expect(result).toEqual({
      valid: false,
      unsupportedClaims: ["quota: kuota kakak masih 10 porsi"],
    });
  });

  test("context carries the bought-not-delivered balance, not only the unbooked count", async () => {
    // Febby held 2 portions still to eat and 0 without a date on 2026-09-02.
    // With only the unbooked number in context, "sisa 2 porsi" — the answer the
    // system prompt tells the model to give — was rejected as a hallucination
    // twice and she got the fallback template instead.
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"valid": true}' }],
    });
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create },
    });

    await validateReply({
      ...baseParams,
      reply: "Sisa kuota kakak 2 porsi ya",
      activeOrder: { unbooked: 0, packageSize: 30, remainingToday: 2 },
    });

    const prompt = create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("2 portions bought and not yet delivered");
    expect(prompt).toContain("0 have no delivery date booked yet");
  });

  test("a hand-typed outbound line is labelled ADMIN, the bot's own BOT", async () => {
    // +6281212021234 on 2026-09-11: an admin quoted 12 porsi / Rp 336.000 by
    // hand, no order row exists for an untendered event, so with every outbound
    // line marked BOT the draft reading our own offer back was unsupported by
    // construction and the customer got the fallback template.
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"valid": true}' }],
    });
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create },
    });

    await validateReply({
      ...baseParams,
      reply: "Betul kak, 12 porsi Rp 336.000 ya",
      transcript: [
        {
          role: "assistant",
          content: "12 porsi Rp 336.000",
          sentBy: "annie@x",
        },
        {
          role: "assistant",
          content: "Ada lagi yang bisa dibantu?",
          sentBy: null,
        },
        { role: "user", content: "harinya bisa tukar?" },
      ],
    });

    const prompt = create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("ADMIN: 12 porsi Rp 336.000");
    expect(prompt).toContain("BOT: Ada lagi yang bisa dibantu?");
    expect(prompt).toContain("CUSTOMER: harinya bisa tukar?");
  });

  test("context carries the dates already booked", async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"valid": true}' }],
    });
    (getAnthropicClient as jest.Mock).mockReturnValue({ messages: { create } });

    await validateReply({
      ...baseParams,
      activeOrder: { unbooked: 3, packageSize: 102, remainingToday: 6 },
      upcoming: [{ date: "2026-09-22", mealType: "dinner", portions: 1 }],
    });

    const prompt = create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("2026-09-22 dinner 1 porsi");
  });

  // The half of the false-positive fix that does not depend on the model taking
  // an instruction. Every case below is a flag Haiku actually raised on
  // 2026-09-20, filed under whichever field was still unconstrained.
  describe("off-scope flags are dropped rather than sent", () => {
    function blocks(claims: unknown[]) {
      mockCreate({
        content: [
          {
            type: "text",
            text: JSON.stringify({ valid: false, unsupported_claims: claims }),
          },
        ],
      });
    }

    const withOrder = {
      ...baseParams,
      activeOrder: { unbooked: 3, packageSize: 102, remainingToday: 6 },
    };

    test("a field outside the five is not a claim", async () => {
      blocks([{ field: "price", claim: "potongan tanpa nasi Rp 2.000" }]);
      expect(await validateReply(baseParams)).toEqual({
        valid: true,
        unsupportedClaims: [],
      });
    });

    test("a flag with no field at all is not a claim", async () => {
      blocks(["Menunya untuk Senin 21 sampai Sabtu 26 September 2026"]);
      expect((await validateReply(baseParams)).valid).toBe(true);
    });

    test("a kitchen nickname is not the customer's name", async () => {
      blocks([{ field: "name", claim: "Dapur Palem" }]);
      expect((await validateReply(baseParams)).valid).toBe(true);
    });

    test("the honorific everyone gets is not a name", async () => {
      blocks([{ field: "name", claim: "kak" }]);
      expect((await validateReply(baseParams)).valid).toBe(true);
    });

    test("one of our own staff is not the customer's name", async () => {
      blocks([
        { field: "name", claim: "Jennifer memang bagian dari tim kami" },
      ]);
      expect((await validateReply(baseParams)).valid).toBe(true);
    });

    test("a real name still blocks", async () => {
      blocks([{ field: "name", claim: "kak Siti" }]);
      expect((await validateReply(baseParams)).valid).toBe(false);
    });

    test("a quota flag quoting no porsi count is not a claim", async () => {
      blocks([{ field: "quota", claim: "langganan harian tanpa nasi" }]);
      expect((await validateReply(withOrder)).valid).toBe(true);
    });

    test("a menu week read as a quota is not a claim", async () => {
      // "21", "26" and "2026" are not portion counts, and reading any digit in
      // the sentence as one blocked a draft about the menu week.
      blocks([
        {
          field: "quota",
          claim: "Menunya untuk Senin 21 sampai Sabtu 26 September 2026",
        },
      ]);
      expect((await validateReply(withOrder)).valid).toBe(true);
    });

    test("either of the two quota numbers is supported", async () => {
      blocks([{ field: "quota", claim: "sisanya 3 porsi" }]);
      expect((await validateReply(withOrder)).valid).toBe(true);
    });

    test("a third quota number still blocks", async () => {
      blocks([{ field: "quota", claim: "sisa kuota kakak 40 porsi" }]);
      expect(await validateReply(withOrder)).toEqual({
        valid: false,
        unsupportedClaims: ["quota: sisa kuota kakak 40 porsi"],
      });
    });

    test("an order-status flag on a customer who has an order is a guess", async () => {
      // CONTEXT carries no status, so with an order on file there is nothing to
      // check it against. "tidak bisa dibuka lagi" — the cutoff — came back
      // filed here.
      blocks([{ field: "order_status", claim: "tidak bisa dibuka lagi" }]);
      expect((await validateReply(withOrder)).valid).toBe(true);
    });

    test("an order-status flag that asserts nothing is not a claim", async () => {
      blocks([{ field: "order_status", claim: "langganan harian tanpa nasi" }]);
      expect((await validateReply(baseParams)).valid).toBe(true);
    });

    test("an invented active order on a customer with none still blocks", async () => {
      blocks([{ field: "order_status", claim: "Langganan kakak sudah aktif" }]);
      expect((await validateReply(baseParams)).valid).toBe(false);
    });

    test("the event field is dropped off an event-free thread", async () => {
      blocks([{ field: "event", claim: "potongan tanpa nasi Rp 2.000" }]);
      expect((await validateReply(baseParams)).valid).toBe(true);
    });

    test("the event field stands on an event thread", async () => {
      blocks([{ field: "event", claim: "sudah termasuk air mineral" }]);
      const result = await validateReply({
        ...baseParams,
        reply: "Untuk acara arisan kakak, sudah termasuk air mineral ya.",
      });
      expect(result.valid).toBe(false);
    });
  });

  test("the bot's own daily-or-event question does not make it an event", async () => {
    // "acara" in our own qualifying question put a daily-subscription lead
    // under EVENT_RULES on 2026-09-20, where the per-kitchen no-rice discounts
    // stopped being general business info and her reply was blocked twice.
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"valid": true}' }],
    });
    (getAnthropicClient as jest.Mock).mockReturnValue({ messages: { create } });

    await validateReply({
      ...baseParams,
      reply: "Bisa kok kak, langganan harian tanpa nasi.",
      transcript: [
        {
          role: "assistant",
          content:
            "ini untuk *langganan harian* atau untuk *acara sekali jalan* ya kak?",
          sentBy: null,
        },
        { role: "user", content: "Langganan harian tp tanpa nasi" },
      ],
    });

    expect(create.mock.calls[0][0].system).not.toContain("acara sekali jalan)");
  });

  test("malformed JSON fails open (valid: true)", async () => {
    mockCreate({ content: [{ type: "text", text: "not json" }] });

    const result = await validateReply(baseParams);

    expect(result).toEqual({ valid: true, unsupportedClaims: [] });
  });

  test("API error fails open (valid: true)", async () => {
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: {
        create: jest.fn().mockRejectedValue(new Error("network error")),
      },
    });

    const result = await validateReply(baseParams);

    expect(result).toEqual({ valid: true, unsupportedClaims: [] });
  });
});
