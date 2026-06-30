import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/manual-reply/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextMessage: jest.fn().mockResolvedValue(undefined),
}));

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
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) {
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    }
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/manual-reply", {
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

describe("POST /api/inbox/manual-reply", () => {
  test("T1 — sends text, saves conversation, clears pending bot reply", async () => {
    const db = makeDbMock({
      customers: { data: { phone_number: "+6281234567890" }, error: null },
      conversations: { data: { id: "conv-1" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", text: "Siap kak, jam 5 bisa" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "+6281234567890",
      "Siap kak, jam 5 bisa",
    );
    expect(db.chains.conversations.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        role: "assistant",
        model_used: "human",
      }),
    );
    expect(db.chains.customer_flags.update).toHaveBeenCalledWith({
      last_human_activity_at: expect.any(String),
      pending_bot_response: false,
      pending_bot_question: null,
    });
    expect(db.chains.customer_flags.eq).toHaveBeenCalledWith(
      "customer_id",
      "cust-1",
    );
  });
});
