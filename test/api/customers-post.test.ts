import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { POST } from "@/app/api/customers/route";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "order", "in", "limit"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock() {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain();
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/customers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user: { id: "u1", email: "admin@example.com" } } }) },
  });
});

describe("POST /api/customers", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null } }) },
    });
    const res = await POST(postRequest({ phone_number: "+628111" }));
    expect(res.status).toBe(401);
  });

  test("T2 — missing phone_number returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(postRequest({ name: "Alice" }));
    expect(res.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });

  test("T3 — duplicate phone returns 409", async () => {
    const db = makeDbMock();
    db.from("customers");
    db.chains.customers.maybeSingle.mockResolvedValue({ data: { id: "existing-1" }, error: null });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ phone_number: "+628111" }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.existingId).toBe("existing-1");
    expect(db.chains.customers.insert).not.toHaveBeenCalled();
  });

  test("T4 — creates customer with allowlisted fields, trims phone", async () => {
    const db = makeDbMock();
    db.from("customers");
    db.chains.customers.maybeSingle.mockResolvedValue({ data: null, error: null });
    db.chains.customers.single.mockResolvedValue({ data: { id: "new-1", name: "Alice", phone_number: "+628111" }, error: null });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ phone_number: "  +628111  ", name: "Alice", area: "BSD Baru", subcontractor_id: "sub-1", evil: "ignored" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.id).toBe("new-1");
    expect(db.chains.customers.insert).toHaveBeenCalledWith(
      expect.objectContaining({ phone_number: "+628111", name: "Alice", area: "BSD Baru", subcontractor_id: "sub-1" }),
    );
    // Allowlist: no stray field leaks through
    expect(db.chains.customers.insert.mock.calls[0][0]).not.toHaveProperty("evil");
  });
});
