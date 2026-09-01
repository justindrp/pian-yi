import { NextRequest } from "next/server";
import { DELETE, PATCH } from "@/app/api/orders/route";
import { createJournalEntry } from "@/lib/accounting/journal";
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

// `listData` is what a select that is not `.single()` resolves to. Both
// mark_paid paths now read the customer's active orders as a list from the same
// `orders` table they fetch the paid order from, and a list select resolves to
// an array, never to the single row.
function makeChain(
  result: { data: unknown; error: unknown; listData?: unknown } = {
    data: null,
    error: null,
  },
) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "eq",
    "neq",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "in",
    "limit",
    "order",
    "is",
    "range",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  const listResult = { data: result.listData ?? null, error: result.error };
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(listResult).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(listResult).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  config: Record<
    string,
    { data: unknown; error: unknown; listData?: unknown }
  > = {},
) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table])
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
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

function deleteRequest(body: unknown) {
  return new NextRequest("http://localhost/api/orders", {
    method: "DELETE",
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
          start_date: "2099-01-05",
          end_date: "2099-01-07",
          meal_time_preference: "lunch_only",
          portions_per_delivery: 1,
          portions_lunch: null,
          portions_dinner: null,
          subcontractor_id: "sub-1",
          lunch_address_slot: 2,
          dinner_address_slot: 1,
          customers: { name: "Test Customer", phone_number: "+628111222333" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
      daily_deliveries: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({ id: "order-1", action: "mark_paid" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
    expect(db.from).not.toHaveBeenCalledWith("customer_state");
  });

  test("T1a — mark_paid credits the ongkir to 2101, not to Unearned Revenue", async () => {
    // Sharleen, 2026-08-31: Rp 220.000 of Akasa ongkir sat inside total_price
    // and went to 2100 with the food. Revenue recognition only ever draws 2100
    // down by portions × price_per_portion, so it would have stayed there for
    // good. Ongkir is a pass-through — collected from the customer, owed to the
    // kitchen — so it is held apart and released a delivery day at a time.
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-1",
          customer_id: "cust-1",
          total_price: 1910000,
          delivery_surcharge_total: 220000,
          package_size: 65,
          requested_schedule: null,
          customers: { name: "Sharleen", phone_number: "+628111090929" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await PATCH(patchRequest({ id: "order-1", action: "mark_paid" }));

    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          { accountCode: "1002", debit: 1910000, credit: 0 },
          { accountCode: "2100", debit: 0, credit: 1690000 },
          { accountCode: "2101", debit: 0, credit: 220000 },
        ],
      }),
    );
  });

  test("T1a2 — an order with no surcharge posts the same two lines as before", async () => {
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-1",
          customer_id: "cust-1",
          total_price: 280000,
          delivery_surcharge_total: 0,
          package_size: 10,
          requested_schedule: null,
          customers: { name: "Test Customer", phone_number: "+628111222333" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await PATCH(patchRequest({ id: "order-1", action: "mark_paid" }));

    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          { accountCode: "1002", debit: 280000, credit: 0 },
          { accountCode: "2100", debit: 0, credit: 280000 },
        ],
      }),
    );
  });

  test("T1b — mark_paid writes the days stored on the order, and nothing else", async () => {
    // The rows are the schedule the customer asked for, held on
    // orders.requested_schedule since order creation. mark_paid is the only
    // thing that turns them into deliveries: before this, they were written at
    // order creation, and nothing filters the kitchen sheet by order status, so
    // three unpaid orders had 37 portions queued for a kitchen on 2026-08-28.
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-1",
          customer_id: "cust-1",
          total_price: 30000,
          package_size: 30,
          start_date: "2099-01-05",
          end_date: "2099-01-07",
          requested_schedule: [
            { date: "2099-01-05", meal_type: "lunch", portions: 1 },
            { date: "2099-01-06", meal_type: "lunch", portions: 1 },
            { date: "2099-01-07", meal_type: "lunch", portions: 1 },
          ],
          portions_per_delivery: 1,
          portions_lunch: null,
          portions_dinner: null,
          subcontractor_id: "sub-1",
          lunch_address_slot: 2,
          dinner_address_slot: 1,
          customers: { name: "Test Customer", phone_number: "+628111222333" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
      daily_deliveries: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await PATCH(patchRequest({ id: "order-1", action: "mark_paid" }));

    expect(db.chains.daily_deliveries.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          delivery_date: "2099-01-05",
          meal_type: "lunch",
          address_slot: 2,
        }),
        expect.objectContaining({
          delivery_date: "2099-01-06",
          meal_type: "lunch",
          address_slot: 2,
        }),
        expect.objectContaining({
          delivery_date: "2099-01-07",
          meal_type: "lunch",
          address_slot: 2,
        }),
      ],
      expect.objectContaining({
        ignoreDuplicates: true,
        onConflict: "delivery_date,customer_id,meal_type",
      }),
    );
  });

  // Veronica Catherine, 2026-08-30: 1 porsi left on the June order, seven days
  // wanted, a 6-porsi top-up bought to cover the difference. Every row used to
  // be stamped with the order being paid, so the top-up sat 1 over its own
  // package while the June order kept a portion it had been paid for and could
  // never complete. The first date belongs to the older package.
  test("T1b2 — mark_paid charges the oldest package with balance first", async () => {
    const db = makeDbMock({
      orders: {
        data: {
          id: "topup",
          customer_id: "cust-1",
          total_price: 174000,
          package_size: 2,
          start_date: "2099-01-05",
          end_date: "2099-01-07",
          requested_schedule: [
            { date: "2099-01-05", meal_type: "lunch", portions: 1 },
            { date: "2099-01-06", meal_type: "lunch", portions: 1 },
            { date: "2099-01-07", meal_type: "lunch", portions: 1 },
          ],
          portions_per_delivery: 1,
          portions_lunch: null,
          portions_dinner: null,
          subcontractor_id: "sub-1",
          lunch_address_slot: 1,
          dinner_address_slot: 1,
          customers: { name: "Test Customer", phone_number: "+628111222333" },
        },
        // The customer's active orders, as the list select returns them: an
        // older 6-porsi package with 1 porsi still unbooked, and the top-up.
        listData: [
          {
            id: "june",
            package_size: 6,
            start_date: "2098-06-17",
            created_at: "2098-06-08T00:00:00Z",
          },
          {
            id: "topup",
            package_size: 2,
            start_date: "2099-01-05",
            created_at: "2099-01-04T00:00:00Z",
          },
        ],
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
      // Five of the June package's six portions are already on the calendar,
      // so it has exactly one left to give.
      daily_deliveries: {
        data: null,
        listData: [
          { order_id: "june", portions: 1 },
          { order_id: "june", portions: 1 },
          { order_id: "june", portions: 1 },
          { order_id: "june", portions: 1 },
          { order_id: "june", portions: 1 },
        ],
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await PATCH(patchRequest({ id: "topup", action: "mark_paid" }));

    const rows = (db.chains.daily_deliveries.upsert as jest.Mock).mock
      .calls[0][0] as { delivery_date: string; order_id: string }[];
    expect(rows.map((r) => [r.delivery_date, r.order_id])).toEqual([
      ["2099-01-05", "june"],
      ["2099-01-06", "topup"],
      ["2099-01-07", "topup"],
    ]);
  });

  test("T1c — mark_paid on an order with no stored schedule writes no rows", async () => {
    // Most of the book buys quota without naming days and books them one at a
    // time through record_daily_order. This route must never invent a pattern
    // for them: it used to derive a whole recurring run from a
    // meal_time_preference enum nobody had checked against what the customer
    // asked for, and 21 of 28 rows built for 2026-08-21 were over-draws.
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-1",
          customer_id: "cust-1",
          total_price: 30000,
          package_size: 30,
          start_date: "2099-01-05",
          end_date: "2099-01-07",
          requested_schedule: null,
          portions_per_delivery: 1,
          portions_lunch: null,
          portions_dinner: null,
          subcontractor_id: "sub-1",
          lunch_address_slot: 2,
          dinner_address_slot: 1,
          customers: { name: "Test Customer", phone_number: "+628111222333" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
      daily_deliveries: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await PATCH(patchRequest({ id: "order-1", action: "mark_paid" }));

    expect(db.chains.daily_deliveries.upsert).not.toHaveBeenCalled();
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

  test("T2b — mark_payment_proof_received advances only pending orders", async () => {
    const db = makeDbMock({
      orders: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({
        id: "order-1",
        action: "mark_payment_proof_received",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // The timestamp goes on with the status. The Payments page used to print
    // `confirmed_at` under "Proof received" — Naya's proof arrived 30 Agu 13.33
    // and her row read "24 Agu 12.12" — so every path that sets the status must
    // set the time too, or the page falls back to the confirmation label.
    expect(db.chains.orders.update).toHaveBeenCalledWith({
      status: "payment_proof_received",
      payment_proof_received_at: expect.any(String),
    });
    expect(db.chains.orders.eq).toHaveBeenCalledWith("id", "order-1");
    expect(db.chains.orders.eq).toHaveBeenCalledWith(
      "status",
      "pending_payment",
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
      patchRequest({
        id: "order-1",
        action: "update_fields",
        fields: { size: "xl" },
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  test("T6 — update_status with safe value (paused) succeeds", async () => {
    const db = makeDbMock({ orders: { data: null, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({
        id: "order-1",
        action: "update_status",
        status: "paused",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
  });

  // The money leaving is not what ends the order — the status is. Pane's
  // Rp 280.000 went out on 2026-09-01 against an order the dashboard could only
  // leave `active`, still holding the 10 porsi she had been refunded for.
  test("T6b — update_status to refunded stamps cancelled_at", async () => {
    const db = makeDbMock({ orders: { data: null, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({
        id: "order-1",
        action: "update_status",
        status: "refunded",
      }),
    );

    expect(res.status).toBe(200);
    expect(db.chains.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "refunded",
        cancelled_at: expect.any(String),
      }),
    );
  });

  test("T7 — update_status with unsafe value (active) returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      patchRequest({
        id: "order-1",
        action: "update_status",
        status: "active",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalledWith("orders");
  });
});

describe("DELETE /api/orders", () => {
  test("T8 — deletes order deliveries before deleting the order", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await DELETE(deleteRequest({ id: "order-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.daily_deliveries.delete).toHaveBeenCalled();
    expect(db.chains.daily_deliveries.eq).toHaveBeenCalledWith(
      "order_id",
      "order-1",
    );
    expect(db.chains.orders.delete).toHaveBeenCalled();
    expect(db.chains.orders.eq).toHaveBeenCalledWith("id", "order-1");

    const tableOrder = (db.from as jest.Mock).mock.calls.map((c) => c[0]);
    expect(tableOrder.indexOf("daily_deliveries")).toBeLessThan(
      tableOrder.indexOf("orders"),
    );
  });

  test("T9 — delete without order id returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await DELETE(deleteRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalledWith("orders");
  });
});
