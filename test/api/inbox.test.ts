import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/bot-reply/route";
import { getAnthropicClient } from "@/lib/claude/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  HAIKU_MODEL: "claude-haiku-test",
}));
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextMessage: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
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
    if (!chains[table])
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/bot-reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeHaikuMock(text: string) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: "text", text }],
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/inbox/bot-reply", () => {
  test("T1 — Haiku polishes answer, sends to customer, clears pending flag", async () => {
    const db = makeDbMock({
      customers: {
        data: { phone_number: "+6281234567890", name: "Budi" },
        error: null,
      },
      customer_flags: {
        data: {
          pending_bot_response: true,
          pending_bot_question: "Kapan dikirim?",
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const polished = "Pesanan kak akan dikirim besok pagi ya!";
    (getAnthropicClient as jest.Mock).mockReturnValue(makeHaikuMock(polished));

    const res = await POST(
      postRequest({ customer_id: "cust-1", admin_answer: "besok pagi" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sent).toBe(polished);

    // Must send the polished text (not the raw admin answer)
    expect(sendTextMessage).toHaveBeenCalledWith("+6281234567890", polished);

    // Must clear the pending flag
    expect(db.chains.customer_flags.update).toHaveBeenCalledWith({
      pending_bot_response: false,
      pending_bot_question: null,
    });
    expect(db.chains.customer_flags.eq).toHaveBeenCalledWith(
      "customer_id",
      "cust-1",
    );
  });

  test("T2 — missing admin_answer returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", admin_answer: "   " }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  test("T3 — unknown customer returns 404", async () => {
    const db = makeDbMock({
      customers: { data: null, error: { message: "No rows found" } },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        customer_id: "does-not-exist",
        admin_answer: "besok pagi",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  test("T4 — no pending_bot_response flag returns 400", async () => {
    const db = makeDbMock({
      customers: {
        data: { phone_number: "+6281234567890", name: "Budi" },
        error: null,
      },
      customer_flags: {
        data: { pending_bot_response: false, pending_bot_question: null },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", admin_answer: "besok pagi" }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
