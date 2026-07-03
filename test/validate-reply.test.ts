import { getAnthropicClient } from "@/lib/claude/client";
import { validateReply } from "@/lib/claude/validate-reply";

jest.mock("@/lib/claude/client", () => ({
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

  test("malformed JSON fails open (valid: true)", async () => {
    mockCreate({ content: [{ type: "text", text: "not json" }] });

    const result = await validateReply(baseParams);

    expect(result).toEqual({ valid: true, unsupportedClaims: [] });
  });

  test("API error fails open (valid: true)", async () => {
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create: jest.fn().mockRejectedValue(new Error("network error")) },
    });

    const result = await validateReply(baseParams);

    expect(result).toEqual({ valid: true, unsupportedClaims: [] });
  });
});
