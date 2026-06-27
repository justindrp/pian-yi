import { NextRequest } from "next/server";
import { POST } from "@/app/api/accounting/accounts/route";
import { PATCH } from "@/app/api/accounting/accounts/[id]/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/get-role", () => ({
  getSessionWithRole: jest.fn(),
  isOwner: (role: string) => role === "owner",
}));

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "insert", "update", "eq", "in", "order"];
  for (const m of methods) chain[m] = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

// Each table can return a different result per call (sequential), since POST hits
// `accounts` twice: existence check (maybeSingle) then insert (single).
function makeDbMock(perTable: Record<string, { data: unknown; error: unknown }[]>) {
  const calls: Record<string, number> = {};
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    const i = calls[table] ?? 0;
    calls[table] = i + 1;
    const result = perTable[table]?.[i] ?? { data: null, error: null };
    chains[`${table}:${i}`] = makeChain(result);
    return chains[`${table}:${i}`];
  });
  return { from, chains };
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/accounting/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/accounting/accounts/a1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const okOwner = { email: "drpramadyo@gmail.com", role: "owner" };

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionWithRole as jest.Mock).mockResolvedValue(okOwner);
});

describe("POST /api/accounting/accounts", () => {
  test("non-owner returns 403", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "a@x.com", role: "admin" });
    const res = await POST(postReq({ code: "6005", name: "X", type: "Expense", category: "Op" }));
    expect(res.status).toBe(403);
  });

  test("invalid code returns 400", async () => {
    const res = await POST(postReq({ code: "ABC", name: "X", type: "Expense", category: "Op" }));
    expect(res.status).toBe(400);
  });

  test("invalid type returns 400", async () => {
    const res = await POST(postReq({ code: "6005", name: "X", type: "Foo", category: "Op" }));
    expect(res.status).toBe(400);
  });

  test("duplicate code returns 400", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ accounts: [{ data: { id: "existing" }, error: null }] }),
    );
    const res = await POST(postReq({ code: "1002", name: "X", type: "Asset", category: "Op" }));
    expect(res.status).toBe(400);
  });

  test("valid create derives normal_balance from type", async () => {
    const db = makeDbMock({
      accounts: [
        { data: null, error: null }, // existence check
        { data: { id: "n1", code: "6005", name: "Sewa", type: "Expense" }, error: null }, // insert
      ],
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(postReq({ code: "6005", name: "Sewa", type: "Expense", category: "Op" }));
    expect(res.status).toBe(200);
    // Insert chain is the second `accounts` call.
    expect(db.chains["accounts:1"].insert).toHaveBeenCalledWith(
      expect.objectContaining({ code: "6005", type: "Expense", normal_balance: "Debit", is_active: true }),
    );
  });

  test("Liability type derives Credit normal balance", async () => {
    const db = makeDbMock({
      accounts: [
        { data: null, error: null },
        { data: { id: "n1" }, error: null },
      ],
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    await POST(postReq({ code: "2005", name: "Utang", type: "Liability", category: "Liab" }));
    expect(db.chains["accounts:1"].insert).toHaveBeenCalledWith(
      expect.objectContaining({ normal_balance: "Credit" }),
    );
  });
});

describe("PATCH /api/accounting/accounts/[id]", () => {
  const params = Promise.resolve({ id: "a1" });

  test("unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);
    const res = await PATCH(patchReq({ is_active: false }), { params });
    expect(res.status).toBe(401);
  });

  test("empty patch returns 400", async () => {
    const res = await PATCH(patchReq({}), { params });
    expect(res.status).toBe(400);
  });

  test("toggle is_active succeeds", async () => {
    const db = makeDbMock({ accounts: [{ data: { id: "a1", is_active: false }, error: null }] });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await PATCH(patchReq({ is_active: false }), { params });
    expect(res.status).toBe(200);
    expect(db.chains["accounts:0"].update).toHaveBeenCalledWith({ is_active: false });
  });
});
