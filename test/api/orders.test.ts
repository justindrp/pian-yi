import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/orders/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/conversation", () => ({
  saveMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/accounting/journal", () => ({
  createJournalEntry: jest.fn().mockResolvedValue(undefined),
}));

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
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
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

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/orders", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

describe("PATCH /api/orders", () => {
  test("T1 — mark_paid sets order status to active", async () => {
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-1",
          customer_id: "cust-1",
          total_price: 30000,
          package_size: 30,
          customers: { name: "Test Customer", phone_number: "+628111222333" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(patchRequest({ id: "order-1", action: "mark_paid" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  test("T2 — update_size m: updates only the size column", async () => {
    const db = makeDbMock({
      orders: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({ id: "order-1", action: "update_size", size: "m" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.orders.update).toHaveBeenCalledWith({ size: "m" });
    // Ensure price was NOT updated
    expect(db.chains.orders.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ price_per_portion: expect.anything() }),
    );
  });

  test("T3 — update_size with invalid value returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({ id: "order-1", action: "update_size", size: "xl" }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalledWith("orders");
  });

  test("T4 — update_fields writes only allowlisted columns, never money/status", async () => {
    const db = makeDbMock({ orders: { data: null, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({
        id: "order-1",
        action: "update_fields",
        fields: {
          area: "BSD Baru",
          delivery_address: "Jl. Baru 1",
          lunch_address_slot: 2,
          portions_lunch: "3",
          // attacker-supplied fields that must be ignored
          total_price: 1,
          status: "active",
          price_per_portion: 1,
        },
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const updateArg = (db.chains.orders.update as jest.Mock).mock.calls[0][0];
    expect(updateArg).toMatchObject({
      area: "BSD Baru",
      delivery_address: "Jl. Baru 1",
      lunch_address_slot: 2,
      portions_lunch: 3,
    });
    expect(updateArg).not.toHaveProperty("total_price");
    expect(updateArg).not.toHaveProperty("status");
    expect(updateArg).not.toHaveProperty("price_per_portion");
  });

  test("T5 — update_fields with invalid size returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({ id: "order-1", action: "update_fields", fields: { size: "xl" } }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  test("T6 — update_status with safe value (paused) succeeds", async () => {
    const db = makeDbMock({ orders: { data: null, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({ id: "order-1", action: "update_status", status: "paused" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
  });

  test("T7 — update_status with unsafe value (active) returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({ id: "order-1", action: "update_status", status: "active" }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalledWith("orders");
  });
});
