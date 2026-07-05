import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/learn-context/route";
import { getAnthropicClient } from "@/lib/claude/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  HAIKU_MODEL: "claude-haiku-4-5",
}));

function makeChain(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "update", "eq", "order", "limit"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table])
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/learn-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest
        .fn()
        .mockResolvedValue({ data: { user: { email: "a@test.com" } } }),
    },
  });
  (getAnthropicClient as jest.Mock).mockReturnValue({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: "- Customer suka menu ayam\n- Minta siang saja",
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    },
  });
});

describe("POST /api/inbox/learn-context", () => {
  test("summarizes recent chat into customers.notes learned block", async () => {
    const db = makeDbMock({
      customers: { data: { id: "cust-1", notes: "VIP" }, error: null },
      conversations: {
        data: [
          {
            role: "user",
            content: "Halo, mau tanya menu",
            message_type: "text",
            created_at: "2026-01-01",
          },
          {
            role: "assistant",
            content: "Siap kak, ada apa ya?",
            message_type: "text",
            created_at: "2026-01-01",
          },
          {
            role: "user",
            content: "Ada menu ayam ga?",
            message_type: "text",
            created_at: "2026-01-02",
          },
          {
            role: "assistant",
            content: "Ada kak",
            message_type: "text",
            created_at: "2026-01-02",
          },
          {
            role: "user",
            content: "Saya suka menu ayam, siang saja",
            message_type: "text",
            created_at: "2026-01-03",
          },
        ],
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ customer_id: "cust-1" }));

    expect(res.status).toBe(200);
    expect(db.chains.customers.update).toHaveBeenCalledWith({
      notes: expect.stringContaining("[AI learned context]"),
    });
    expect(db.chains.customers.update).toHaveBeenCalledWith({
      notes: expect.stringContaining("Customer suka menu ayam"),
    });
  });
});
