import { getAnthropicClient } from "@/lib/claude/client";
import { validateReply } from "@/lib/claude/validate-reply";

jest.mock("@/lib/claude/client", () => ({
  ...jest.requireActual("@/lib/claude/client"),
  getAnthropicClient: jest.fn(),
  HAIKU_MODEL: "claude-haiku-4-5",
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
          text: '{"valid": false, "unsupported_claims": ["stated quota of 10 not in context"]}',
        },
      ],
    });

    const result = await validateReply({
      ...baseParams,
      reply: "Kuota kakak masih 10 porsi ya",
    });

    expect(result).toEqual({
      valid: false,
      unsupportedClaims: ["stated quota of 10 not in context"],
    });
  });

  test("context carries the bought-not-delivered balance, not only the unbooked count", async () => {
    // Febby held 2 portions still to eat and 0 without a date on 2026-09-02.
    // With only the unbooked number in context, "sisa 2 porsi" — the answer the
    // system prompt tells the model to give — was rejected as a hallucination
    // twice and she got the fallback template instead.
    const create = jest
      .fn()
      .mockResolvedValue({
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
    const create = jest
      .fn()
      .mockResolvedValue({
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
