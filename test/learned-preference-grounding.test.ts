import { getAnthropicClient } from "@/lib/claude/client";
import { learnCustomerContext } from "@/lib/claude/learn-context";

jest.mock("@/lib/claude/client", () => ({
  ...jest.requireActual("@/lib/claude/client"),
  getAnthropicClient: jest.fn(),
  HAIKU_MODEL: "claude-haiku-4-5",
}));
jest.mock("@/lib/claude/safety", () => ({ updateTokenCount: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

/**
 * On 2026-08-30 five customers carried a `Preferensi:` bullet reading "tanpa
 * nasi, tidak pedas, tanpa seafood" and four of them had never said any of it.
 * The three terms were the summarizer prompt's own parenthetical example of
 * what a dietary restriction looks like, and the model copied the example out
 * as fact. Two of the four had deliveries on the sheet — Kurniadi Tan had 16
 * rows starting the next morning — so the kitchen was one night away from
 * cooking rice-free boxes nobody had asked for. Julian S got it worse: the
 * invented list replaced his real request ("tidak ada kacang dan bawang
 * goreng"), which never reached the bullet at all.
 *
 * The bullet is printed on `/dapur/[id]`, which is unauthenticated and is what
 * the kitchen cooks from, so an invented restriction is a wrong meal, not a
 * cosmetic error. These tests pin the prompt: no concrete restriction may
 * appear in the instructions where the model can mistake it for an observation.
 */
function makeDb(messages: { role: string; content: string }[]) {
  const conversations = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: messages, error: null }),
  };
  const customers = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: { id: "cust-1", notes: null },
      error: null,
    }),
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }),
  };
  // learnCustomerContext writes an edit_log row for what it overwrote.
  const editLog = { insert: jest.fn().mockResolvedValue({ error: null }) };
  return {
    from: jest.fn((table: string) => {
      if (table === "customers") return customers;
      if (table === "edit_log") return editLog;
      return conversations;
    }),
  } as never;
}

async function capturePrompt(): Promise<string> {
  const create = jest.fn().mockResolvedValue({
    content: [{ type: "text", text: "- Preferensi: tidak ada permintaan khusus." }],
    usage: { input_tokens: 10, output_tokens: 10 },
    stop_reason: "end_turn",
  });
  (getAnthropicClient as jest.Mock).mockReturnValue({ messages: { create } });

  await learnCustomerContext(
    "cust-1",
    makeDb([
      { role: "user", content: "halo" },
      { role: "user", content: "mau pesan 6 porsi" },
      { role: "user", content: "antar ke Alam Sutera" },
    ]),
  );
  return create.mock.calls[0][0].messages[0].content as string;
}

describe("learnCustomerContext prompt", () => {
  test("states no concrete dietary restriction the model could copy as fact", async () => {
    const prompt = await capturePrompt();
    const instructions = prompt.slice(0, prompt.indexOf("Transcript:"));

    // The exact run that leaked, and each term on its own. A restriction named
    // in the instructions is one the model can emit without transcript support.
    expect(instructions).not.toMatch(/tanpa nasi/i);
    expect(instructions).not.toMatch(/tidak pedas/i);
    expect(instructions).not.toMatch(/tanpa seafood/i);
    expect(instructions).not.toMatch(/alergi/i);
  });

  test("requires the restriction to come from the customer's own message", async () => {
    const instructions = (await capturePrompt()).split("Transcript:")[0];
    expect(instructions).toMatch(/stated it themselves/i);
    expect(instructions).toMatch(/in this transcript/i);
  });

  test("gives an explicit bullet for a customer who stated nothing", async () => {
    const instructions = (await capturePrompt()).split("Transcript:")[0];
    // Without a required wording the model fills the empty bullet with a guess.
    expect(instructions).toContain("Preferensi: tidak ada permintaan khusus.");
  });

  test("still forbids recording our internal protein arrangement", async () => {
    const instructions = (await capturePrompt()).split("Transcript:")[0];
    expect(instructions).toMatch(/protein/i);
  });
});
