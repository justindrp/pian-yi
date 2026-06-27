import { NextRequest } from "next/server";
import { POST } from "@/app/api/accounting/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/get-role", () => ({
  getSessionWithRole: jest.fn(),
  isOwner: (role: string) => role === "owner",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "insert", "delete", "eq", "in", "order"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  const rpc = jest.fn().mockResolvedValue({ data: "JV-2026-001", error: null });
  return { from, rpc, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/accounting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  date: "2026-06-28",
  description: "Beli perlengkapan",
  lines: [
    { accountCode: "6002", debit: 50000, credit: 0 },
    { accountCode: "1002", debit: 0, credit: 50000 },
  ],
};

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "drpramadyo@gmail.com", role: "owner" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/accounting", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(401);
  });

  test("T2 — non-owner returns 403", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "agnes@example.com", role: "admin" });
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(403);
  });

  test("T3 — unbalanced debit/credit returns 400", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(makeDbMock());
    const res = await POST(
      postRequest({
        ...validBody,
        lines: [
          { accountCode: "6002", debit: 50000, credit: 0 },
          { accountCode: "1002", debit: 0, credit: 40000 },
        ],
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("Debit dan kredit harus seimbang");
  });

  test("T4 — unknown account code returns 400", async () => {
    const db = makeDbMock({
      accounts: { data: [{ id: "a1", code: "6002" }], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(postRequest(validBody));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain("Akun tidak dikenal");
  });

  test("T5 — valid balanced entry creates journal + lines", async () => {
    const db = makeDbMock({
      accounts: { data: [{ id: "a1", code: "6002" }, { id: "a2", code: "1002" }], error: null },
      journals: { data: { id: "j1", reference: "JV-2026-001" }, error: null },
      journal_lines: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.reference).toBe("JV-2026-001");

    // Journal header inserted as manual
    expect(db.chains.journals.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source_type: "manual", source_id: null, description: "Beli perlengkapan" }),
    );
    // Two lines inserted with resolved account IDs
    expect(db.chains.journal_lines.insert).toHaveBeenCalledWith([
      { journal_id: "j1", account_id: "a1", debit: 50000, credit: 0 },
      { journal_id: "j1", account_id: "a2", debit: 0, credit: 50000 },
    ]);
  });
});
