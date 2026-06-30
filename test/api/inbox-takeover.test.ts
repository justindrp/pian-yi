import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/takeover/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

function makeChain(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "eq",
    "neq",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "in",
    "limit",
    "order",
    "is",
  ];
  for (const method of methods) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, ReturnType<typeof makeChain>> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) {
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    }
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/takeover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: "u1", email: "admin@example.com" } },
      }),
    },
  });
});

describe("POST /api/inbox/takeover", () => {
  test("clears pending bot response when taking over", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", escalated: true }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.customer_flags.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        escalated_to_human: true,
        escalation_reason: "Manual takeover",
        last_human_activity_at: expect.any(String),
        pending_bot_response: false,
        pending_bot_question: null,
      }),
    );
  });
});
