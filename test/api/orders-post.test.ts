import { NextRequest } from "next/server";
import { POST } from "@/app/api/orders/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/conversation", () => ({ saveMessage: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/whatsapp/client", () => ({ sendTextMessage: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/accounting/journal", () => ({ createJournalEntry: jest.fn().mockResolvedValue(undefined) }));

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

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FUTURE_DATE = "2099-12-31";

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

describe("POST /api/orders — recurring", () => {
  test("T1 — total_price = package_size × price_per_portion", async () => {
    const db = makeDbMock({
      orders: {
        data: { id: "order-1", order_type: "recurring", status: "pending_payment", total_price: 840000 },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        customer_id: "cust-1",
        order_type: "recurring",
        price_per_portion: 28000,
        portions_per_delivery: 1,
        package_size: 30,
        subcontractor_id: null,
        status: "pending_payment",
        start_date: FUTURE_DATE,
        meal_time_preference: "lunch_only",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // total_price must be 30 * 28000 = 840000
    expect(db.chains.orders.insert).toHaveBeenCalledWith(
      expect.objectContaining({ total_price: 840000, package_size: 30 }),
    );
    // address slots default to 1 when not provided
    expect(db.chains.orders.insert).toHaveBeenCalledWith(
      expect.objectContaining({ lunch_address_slot: 1, dinner_address_slot: 1 }),
    );
  });

  test("T1b — per-meal address slots persisted (lunch 1, dinner 2)", async () => {
    const db = makeDbMock({
      orders: { data: { id: "order-1b", order_type: "recurring", status: "active", total_price: 280000 }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(
      postRequest({
        customer_id: "cust-1",
        order_type: "recurring",
        price_per_portion: 28000,
        portions_per_delivery: 1,
        package_size: 10,
        subcontractor_id: null,
        status: "active",
        start_date: FUTURE_DATE,
        meal_time_preference: "both_fixed",
        lunch_address_slot: 1,
        dinner_address_slot: 2,
      }),
    );

    expect(db.chains.orders.insert).toHaveBeenCalledWith(
      expect.objectContaining({ lunch_address_slot: 1, dinner_address_slot: 2 }),
    );
  });

  test("T2 — size defaults to 's' when not provided", async () => {
    const db = makeDbMock({
      orders: { data: { id: "order-2", order_type: "recurring", status: "pending_payment", total_price: 280000 }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(
      postRequest({
        customer_id: "cust-1",
        order_type: "recurring",
        price_per_portion: 28000,
        portions_per_delivery: 1,
        package_size: 10,
        subcontractor_id: null,
        status: "pending_payment",
        start_date: FUTURE_DATE,
        meal_time_preference: "lunch_only",
        // size omitted
      }),
    );

    expect(db.chains.orders.insert).toHaveBeenCalledWith(
      expect.objectContaining({ size: "s" }),
    );
  });

  test("T3 — missing start_date returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        customer_id: "cust-1",
        order_type: "recurring",
        price_per_portion: 28000,
        portions_per_delivery: 1,
        package_size: 10,
        subcontractor_id: null,
        status: "pending_payment",
        meal_time_preference: "lunch_only",
        // start_date omitted
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalledWith("orders");
  });
});

describe("POST /api/orders — scheduled", () => {
  test("T4 — package_size derived from schedule sum, total_price computed correctly", async () => {
    const db = makeDbMock({
      orders: {
        data: { id: "order-3", order_type: "scheduled", status: "pending_payment", total_price: 84000 },
        error: null,
      },
      daily_deliveries: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const schedule = [
      { date: FUTURE_DATE, meal_type: "lunch", portions: 2 },
      { date: "2099-12-30", meal_type: "dinner", portions: 1 },
    ];

    const res = await POST(
      postRequest({
        customer_id: "cust-1",
        order_type: "scheduled",
        price_per_portion: 28000,
        portions_per_delivery: 2,
        subcontractor_id: null,
        status: "pending_payment",
        delivery_schedule: schedule,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // package_size = 2 + 1 = 3, total_price = 3 * 28000 = 84000
    expect(db.chains.orders.insert).toHaveBeenCalledWith(
      expect.objectContaining({ package_size: 3, total_price: 84000 }),
    );
  });

  test("T5 — scheduled delivery rows stamped with per-meal address slot", async () => {
    const db = makeDbMock({
      orders: { data: { id: "order-5", order_type: "scheduled", status: "active", total_price: 84000 }, error: null },
      daily_deliveries: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const schedule = [
      { date: FUTURE_DATE, meal_type: "lunch", portions: 2 },
      { date: "2099-12-30", meal_type: "dinner", portions: 1 },
    ];

    await POST(
      postRequest({
        customer_id: "cust-1",
        order_type: "scheduled",
        price_per_portion: 28000,
        portions_per_delivery: 2,
        subcontractor_id: null,
        status: "active",
        delivery_schedule: schedule,
        lunch_address_slot: 1,
        dinner_address_slot: 2,
      }),
    );

    const upsertRows = (db.chains.daily_deliveries.upsert as jest.Mock).mock.calls[0][0] as Array<{ meal_type: string; address_slot: number }>;
    expect(upsertRows.find((r) => r.meal_type === "lunch")?.address_slot).toBe(1);
    expect(upsertRows.find((r) => r.meal_type === "dinner")?.address_slot).toBe(2);
  });
});
