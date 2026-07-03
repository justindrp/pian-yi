import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { POST } from "@/app/api/customers/free-quota/route";

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
  return new Request("http://localhost/api/customers/free-quota", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: "u1", email: "admin@example.com" } } }),
    },
  });
});

describe("POST /api/customers/free-quota", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null } }) },
    });
    const res = await POST(postRequest({ grants: [{ customer_id: "c1", portions: 5, date: "2026-07-04", reason: "late delivery" }] }));
    expect(res.status).toBe(401);
  });

  test("T2 — empty grants array returns 400", async () => {
    const db = makeDbMock({ admin_users: { data: { role: "admin" }, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(postRequest({ grants: [] }));
    expect(res.status).toBe(400);
  });

  test("T3 — grant missing reason returns 400 without hitting DB", async () => {
    const db = makeDbMock({ admin_users: { data: { role: "admin" }, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(
      postRequest({ grants: [{ customer_id: "c1", portions: 5, date: "2026-07-04", reason: "  " }] }),
    );
    expect(res.status).toBe(400);
    expect(db.chains.customers).toBeUndefined();
  });

  test("T4 — grant with portions <= 0 returns 400", async () => {
    const db = makeDbMock({ admin_users: { data: { role: "admin" }, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(
      postRequest({ grants: [{ customer_id: "c1", portions: 0, date: "2026-07-04", reason: "oops" }] }),
    );
    expect(res.status).toBe(400);
  });

  test("T5 — unknown customer_id returns 400 without inserting", async () => {
    const db = makeDbMock({
      admin_users: { data: { role: "admin" }, error: null },
      customers: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    const res = await POST(
      postRequest({ grants: [{ customer_id: "missing-1", portions: 5, date: "2026-07-04", reason: "late delivery" }] }),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/missing-1/);
    expect(db.chains.orders).toBeUndefined();
  });

  test("T6 — valid single grant inserts Rp0 free_quota order, bumps portions_remaining, writes edit_log", async () => {
    const db = makeDbMock({
      admin_users: { data: { role: "admin" }, error: null },
      customers: { data: [{ id: "c1", area: "BSD Baru", address: "Jl A", portions_remaining: 10 }], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    // orders.insert(...).select("id") resolves via .then on the chain
    db.from("orders");
    db.chains.orders.select.mockReturnValue({
      // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: "order-1" }], error: null }).then(resolve),
    });

    const res = await POST(
      postRequest({
        grants: [{ customer_id: "c1", portions: 5, date: "2026-07-04", reason: "late delivery compensation" }],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.created).toBe(1);

    expect(db.chains.orders.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        customer_id: "c1",
        price_per_portion: 0,
        total_price: 0,
        package_size: 5,
        portions_remaining: 5,
        source: "free_quota",
        grant_reason: "late delivery compensation",
        granted_by: "admin@example.com",
        area: "BSD Baru",
        delivery_address: "Jl A",
      }),
    ]);

    expect(db.chains.customers.update).toHaveBeenCalledWith({ portions_remaining: 15 });

    expect(db.chains.edit_log.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "orders",
        action: "grant_free_quota",
        changed_by: "admin@example.com",
      }),
    );
  });
});
