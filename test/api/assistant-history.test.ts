import { NextRequest } from "next/server";
import {
  DELETE,
  GET as GET_MSG,
} from "@/app/api/assistant/conversations/[id]/route";
import { GET, POST } from "@/app/api/assistant/conversations/route";
import { saveTurn } from "@/lib/claude/assistant-history";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/get-role", () => ({ getSessionWithRole: jest.fn() }));

// ---------------------------------------------------------------------------
// Helpers — minimal Supabase query-chain mock
// ---------------------------------------------------------------------------

function makeChain(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "order",
    "limit",
    "values",
    "map",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

function makeDbMock(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain = makeChain(result);
  return { from: jest.fn().mockReturnValue(chain), chain };
}

function asJson(res: Response) {
  return res.json() as Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionWithRole as jest.Mock).mockResolvedValue({
    email: "a@b.com",
    role: "owner",
  });
});

// ---------------------------------------------------------------------------
// Conversations list / create
// ---------------------------------------------------------------------------

describe("GET /api/assistant/conversations", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  test("T2 — returns conversation list", async () => {
    const data = [
      { id: "c1", title: "Hello world", updated_at: "2026-06-26T00:00:00Z" },
    ];
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ data, error: null }),
    );
    const res = await GET();
    const body = await asJson(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(data);
  });
});

describe("POST /api/assistant/conversations", () => {
  test("T3 — creates conversation and returns id", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ data: { id: "new-id" }, error: null }),
    );
    const res = await POST();
    const body = await asJson(res);
    expect(body.ok).toBe(true);
    expect((body.data as { id: string }).id).toBe("new-id");
  });

  test("T4 — insert error returns 500", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ data: null, error: {} }),
    );
    const res = await POST();
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Conversation by id
// ---------------------------------------------------------------------------

describe("GET /api/assistant/conversations/[id]", () => {
  test("T5 — unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);
    const res = await GET_MSG(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(res.status).toBe(401);
  });

  test("T6 — returns messages", async () => {
    const data = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ data, error: null }),
    );
    const res = await GET_MSG(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "c1" }),
    });
    const body = await asJson(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(data);
  });
});

describe("DELETE /api/assistant/conversations/[id]", () => {
  test("T7 — unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);
    const res = await DELETE(
      new NextRequest("http://localhost/x", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "c1" }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("T8 — deletes conversation", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ data: null, error: null }),
    );
    const res = await DELETE(
      new NextRequest("http://localhost/x", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "c1" }),
      },
    );
    const body = await asJson(res);
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveTurn title derivation
// ---------------------------------------------------------------------------

describe("saveTurn", () => {
  test("T9 — first message sets title derived from user text", async () => {
    const db = makeDbMock({ data: null, error: null });
    await saveTurn(db as never, {
      conversationId: "c1",
      userText: "How many active orders today?",
      assistantText: "5",
      isFirstMessage: true,
    });
    const updateMock = db.chain.update as jest.Mock;
    expect(updateMock).toHaveBeenCalled();
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      title: "How many active orders today?",
      updated_at: expect.any(String),
    });
  });

  test("T10 — non-first message does not set title", async () => {
    const db = makeDbMock({ data: null, error: null });
    await saveTurn(db as never, {
      conversationId: "c1",
      userText: "thanks",
      assistantText: "welcome",
      isFirstMessage: false,
    });
    const updateMock = db.chain.update as jest.Mock;
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty("title");
  });
});
