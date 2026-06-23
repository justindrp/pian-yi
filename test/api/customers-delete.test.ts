import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { DELETE } from "@/app/api/customers/[id]/route";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "upsert", "update", "delete",
    "eq", "neq", "or", "not", "lt", "gt", "gte", "lte", "in",
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

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function deleteRequest(id: string) {
  return {
    req: new Request(`http://localhost/api/customers/${id}`),
    ctx: { params: Promise.resolve({ id }) },
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

describe("DELETE /api/customers/[id]", () => {
  test("T1 — detaches proofs, deletes deliveries, orders, then customer in order", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const { req, ctx } = deleteRequest("cust-1");
    const res = await DELETE(req, ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    // Must detach proofs (update matched_customer_id → null)
    expect(db.chains.delivery_proofs.update).toHaveBeenCalledWith({ matched_customer_id: null });
    expect(db.chains.delivery_proofs.eq).toHaveBeenCalledWith("matched_customer_id", "cust-1");

    // Must delete deliveries and orders before customer
    expect(db.chains.daily_deliveries.delete).toHaveBeenCalled();
    expect(db.chains.orders.delete).toHaveBeenCalled();
    expect(db.chains.customers.delete).toHaveBeenCalled();

    // Verify call order via from() invocations
    const tableOrder = (db.from as jest.Mock).mock.calls.map((c) => c[0]);
    expect(tableOrder.indexOf("delivery_proofs")).toBeLessThan(tableOrder.indexOf("daily_deliveries"));
    expect(tableOrder.indexOf("daily_deliveries")).toBeLessThan(tableOrder.indexOf("orders"));
    expect(tableOrder.indexOf("orders")).toBeLessThan(tableOrder.indexOf("customers"));
  });

  test("T2 — stops early and returns 500 if proof detach fails", async () => {
    const db = makeDbMock({
      delivery_proofs: { data: null, error: { message: "FK violation" } },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const { req, ctx } = deleteRequest("cust-1");
    const res = await DELETE(req, ctx);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    // Customer must NOT have been deleted
    expect(db.from).not.toHaveBeenCalledWith("customers");
  });

  test("T3 — unauthenticated request returns 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      },
    });
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const { req, ctx } = deleteRequest("cust-1");
    const res = await DELETE(req, ctx);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });
});
