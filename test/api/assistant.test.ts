import { NextRequest } from "next/server";
import { POST } from "@/app/api/assistant/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAnthropicClient } from "@/lib/claude/client";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { buildPendingAction } from "@/lib/claude/assistant-tools";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "claude-sonnet-4-6",
}));
jest.mock("@/lib/supabase/get-role", () => ({ getSessionWithRole: jest.fn() }));
jest.mock("@/lib/claude/assistant-tools", () => {
  const real = jest.requireActual("@/lib/claude/assistant-tools");
  return {
    ...real,
    buildPendingAction: jest.fn().mockResolvedValue({
      tool: "mark_order_paid",
      input: { order_id: "order-1" },
      label: "Mark order as paid — Rp 290,000",
      details: ["Customer: Budi"],
      dangerous: false,
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown; count?: number } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "upsert", "update", "delete",
    "eq", "neq", "or", "not", "lt", "gt", "gte", "lte", "in", "ilike",
    "limit", "order", "is",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(config: Record<string, { data: unknown; error: unknown; count?: number }> = {}) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: [], error: null, count: 0 });
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeClaudeMock(responses: Array<{ content: Array<{ type: string; [k: string]: unknown }>; stop_reason: string }>) {
  let call = 0;
  return {
    messages: {
      create: jest.fn().mockImplementation(() => {
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return Promise.resolve(resp);
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "drpramadyo@gmail.com", role: "owner" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/assistant", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);

    const res = await POST(postRequest({ messages: [{ role: "user", content: "hello" }] }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("T2 — missing messages returns 400", async () => {
    const res = await POST(postRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("T3 — Claude returns tool_use, handler fires, final text returned", async () => {
    const db = makeDbMock({
      orders: { data: [], error: null, count: 5 },
      daily_deliveries: { data: [], error: null, count: 3 },
      customer_state: { data: [], error: null, count: 2 },
      delivery_proofs: { data: [], error: null, count: 1 },
      journal_lines: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    (getAnthropicClient as jest.Mock).mockReturnValue(
      makeClaudeMock([
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "query_metrics",
              input: {},
            },
          ],
        },
        {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "You have 5 active orders today." }],
        },
      ]),
    );

    const res = await POST(
      postRequest({ messages: [{ role: "user", content: "how many active orders?" }] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.text).toBe("You have 5 active orders today.");
  });

  test("T4 — query_metrics queries correct tables", async () => {
    const db = makeDbMock({
      orders: { data: [], error: null, count: 7 },
      daily_deliveries: { data: [], error: null, count: 4 },
      customer_state: { data: [], error: null, count: 0 },
      delivery_proofs: { data: [], error: null, count: 2 },
      journal_lines: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    (getAnthropicClient as jest.Mock).mockReturnValue(
      makeClaudeMock([
        {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "query_metrics", input: {} }],
        },
        {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      ]),
    );

    await POST(postRequest({ messages: [{ role: "user", content: "metrics" }] }));

    expect(db.from).toHaveBeenCalledWith("orders");
    expect(db.from).toHaveBeenCalledWith("daily_deliveries");
    expect(db.from).toHaveBeenCalledWith("customer_state");
    expect(db.from).toHaveBeenCalledWith("delivery_proofs");
  });

  test("T6 — Claude calls write tool, pendingAction returned, no DB update", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    (getAnthropicClient as jest.Mock).mockReturnValue(
      makeClaudeMock([
        {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "I'll mark that order as paid." },
            { type: "tool_use", id: "t1", name: "mark_order_paid", input: { order_id: "order-1" } },
          ],
        },
      ]),
    );

    const res = await POST(
      postRequest({ messages: [{ role: "user", content: "mark order order-1 as paid" }] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.pendingAction).toBeDefined();
    expect(body.pendingAction.tool).toBe("mark_order_paid");
    expect(buildPendingAction as jest.Mock).toHaveBeenCalledWith("mark_order_paid", { order_id: "order-1" });
    // orders table must NOT have been updated
    expect(db.chains.orders?.update).toBeUndefined();
  });

  test("T7 — write tool after read tool: loop terminates with pendingAction", async () => {
    const db = makeDbMock({
      orders: { data: [], error: null, count: 3 },
      daily_deliveries: { data: [], error: null, count: 2 },
      customer_state: { data: [], error: null, count: 0 },
      delivery_proofs: { data: [], error: null, count: 1 },
      journal_lines: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    (getAnthropicClient as jest.Mock).mockReturnValue(
      makeClaudeMock([
        // turn 1: read tool
        {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "query_metrics", input: {} }],
        },
        // turn 2: write tool
        {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Looks like order-1 is unpaid. Marking it now." },
            { type: "tool_use", id: "t2", name: "mark_order_paid", input: { order_id: "order-1" } },
          ],
        },
      ]),
    );

    const res = await POST(
      postRequest({ messages: [{ role: "user", content: "check metrics then mark order-1 paid" }] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.pendingAction).toBeDefined();
    expect(body.pendingAction.tool).toBe("mark_order_paid");
    // loop should have called create exactly twice
    const mockCreate = (getAnthropicClient as jest.Mock).mock.results[0].value.messages.create;
    expect(mockCreate.mock.calls.length).toBe(2);
  });

  test("T5 — tool loop caps at 5 turns and still returns", async () => {
    const db = makeDbMock({
      orders: { data: [], error: null, count: 0 },
      daily_deliveries: { data: [], error: null, count: 0 },
      customer_state: { data: [], error: null, count: 0 },
      delivery_proofs: { data: [], error: null, count: 0 },
      journal_lines: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    // Claude always returns tool_use — loop must cap and not hang
    const alwaysToolUse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "query_metrics", input: {} }],
    };
    (getAnthropicClient as jest.Mock).mockReturnValue(
      makeClaudeMock(Array(10).fill(alwaysToolUse)),
    );

    const res = await POST(
      postRequest({ messages: [{ role: "user", content: "loop test" }] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // create() must have been called at most MAX_TURNS (5) times
    const mockCreate = (getAnthropicClient as jest.Mock).mock.results[0].value.messages.create;
    expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
