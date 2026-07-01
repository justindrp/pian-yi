import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { GET, POST } from "@/app/api/customers/route";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

type Chain = Record<string, jest.Mock> & {
  then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
};

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }): Chain {
  const chain = {} as Chain;
  for (const m of ["select", "insert", "update", "delete", "eq", "order", "in", "limit"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // Supabase query builder is thenable; awaiting a terminal chain (e.g. .order())
  // resolves to { data, error }.
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: null, error: null });
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
    const res = await POST(postRequest({ name: "Alice", address: "Jl A" }));
    expect(res.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });

  test("T2b — missing address returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(postRequest({ phone_number: "+628111", name: "Alice" }));
    expect(res.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });

  test("T3 — duplicate phone returns 409", async () => {
    const db = makeDbMock();
    db.from("customers");
    db.chains.customers.maybeSingle.mockResolvedValue({ data: { id: "existing-1" }, error: null });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ phone_number: "+628111", address: "Jl A" }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.existingId).toBe("existing-1");
    expect(db.chains.customers.insert).not.toHaveBeenCalled();
  });

  test("T4 — creates customer with allowlisted fields, trims phone, address_2 optional", async () => {
    const db = makeDbMock();
    db.from("customers");
    db.chains.customers.maybeSingle.mockResolvedValue({ data: null, error: null });
    db.chains.customers.single.mockResolvedValue({ data: { id: "new-1", name: "Alice", phone_number: "+628111" }, error: null });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ phone_number: "  +628111  ", name: "Alice", address: "Jl A", address_2: "Jl B", area: "BSD Baru", subcontractor_id: "sub-1", evil: "ignored" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.id).toBe("new-1");
    expect(db.chains.customers.insert).toHaveBeenCalledWith(
      expect.objectContaining({ phone_number: "+628111", name: "Alice", address: "Jl A", address_2: "Jl B", area: "BSD Baru", subcontractor_id: "sub-1" }),
    );
    // Allowlist: no stray field leaks through
    expect(db.chains.customers.insert.mock.calls[0][0]).not.toHaveProperty("evil");
  });
});

describe("GET /api/customers", () => {
  test("G1 — default lists only paid customers (queries orders, filters by id)", async () => {
    const db = makeDbMock({
      orders: { data: [{ customer_id: "cust-1" }], error: null },
      customers: { data: [{ id: "cust-1", name: "Alice" }], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await GET(new Request("http://localhost/api/customers"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(db.from).toHaveBeenCalledWith("orders");
    expect(db.chains.customers.in).toHaveBeenCalledWith("id", ["cust-1"]);
    expect(json.data).toHaveLength(1);
  });

  test("G2 — ?all=true returns every customer without the paid filter", async () => {
    const db = makeDbMock({
      orders: { data: [], error: null },
      customers: { data: [{ id: "cust-1", name: "Alice" }, { id: "cust-2", name: "Elaine" }], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await GET(new Request("http://localhost/api/customers?all=true"));
    const json = await res.json();

    expect(res.status).toBe(200);
    // No id filter on customers — a just-created, order-less customer
    // (Elaine) is included. Orders is still queried, to attach each
    // customer's own active_order_id (used for the "draws from" link).
    expect(db.chains.customers.in).not.toHaveBeenCalled();
    expect(json.data).toHaveLength(2);
    expect(json.data[0]).toHaveProperty("active_order_id", null);
  });
});
