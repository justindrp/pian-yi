import {
  loadCustomerSchedule,
  unbookedByOrder,
} from "@/lib/orders/customer-schedule";
import { recordDailyOrder } from "@/lib/orders/record-daily-order";
import { sendPushToAllAdmins } from "@/lib/push/send";

jest.mock("@/lib/orders/customer-schedule", () => ({
  loadCustomerSchedule: jest.fn(),
  unbookedByOrder: jest.fn(),
}));
jest.mock("@/lib/push/send", () => ({
  sendPushToAllAdmins: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// A query builder with just enough surface for this module: `orders` and
// `daily_deliveries` are awaited directly, `customers` ends in .single(), and
// the inserts are captured so a test can say which rows were written.
// ---------------------------------------------------------------------------

type Result = { data: unknown; error: unknown };

function makeDb(config: {
  orders?: Result;
  daily_deliveries?: Result;
  customers?: Result;
  insertError?: { message: string } | null;
}) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const chain = (table: string): Record<string, unknown> => {
    const result: Result =
      table === "orders"
        ? (config.orders ?? { data: [], error: null })
        : table === "daily_deliveries"
          ? (config.daily_deliveries ?? { data: [], error: null })
          : (config.customers ?? { data: null, error: null });

    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "range", "order", "limit"]) {
      c[m] = jest.fn().mockReturnValue(c);
    }
    c.insert = jest.fn((rows: Record<string, unknown>[]) => {
      if (table === "daily_deliveries") inserted.push(...rows);
      return Promise.resolve({ error: config.insertError ?? null });
    });
    c.update = jest.fn((patch: Record<string, unknown>) => {
      updates.push({ table, ...patch });
      return c;
    });
    c.single = jest.fn().mockResolvedValue(result);
    c.maybeSingle = jest.fn().mockResolvedValue(result);
    // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result).then(resolve);
    return c;
  };

  return {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    db: { from: jest.fn((t: string) => chain(t)) } as any,
    inserted,
    updates,
  };
}

const ORDER = {
  id: "order-1",
  package_size: 20,
  start_date: "2026-09-01",
  created_at: "2026-08-01T00:00:00Z",
  subcontractor_id: "sub-1",
};

function call(
  db: unknown,
  input: Partial<Parameters<typeof recordDailyOrder>[0]["input"]> = {},
) {
  return recordDailyOrder({
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    db: db as any,
    customerId: "cust-1",
    phone: "628111222333",
    customerName: "Test Customer",
    input: {
      delivery_dates: ["2026-09-01"],
      meal_type: "lunch",
      portions: 1,
      ...input,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (unbookedByOrder as jest.Mock).mockResolvedValue(new Map([["order-1", 10]]));
  (loadCustomerSchedule as jest.Mock).mockResolvedValue({ unbooked: 10 });
});

describe("recordDailyOrder", () => {
  test("a call with no usable date books nothing and says so", async () => {
    const { db, inserted } = makeDb({});
    const res = await call(db, {
      delivery_dates: ["besok", "2026-13-45"],
      delivery_date: undefined,
    });

    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  // The model copies what it sees in the history, and older transcripts carry
  // the singular field.
  test("the legacy delivery_date field still books", async () => {
    const { db, inserted } = makeDb({ orders: { data: [ORDER], error: null } });
    const res = await call(db, {
      delivery_dates: undefined,
      delivery_date: "2026-09-01",
    });

    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  test("a customer with no active order books nothing", async () => {
    const { db, inserted } = makeDb({ orders: { data: [], error: null } });
    const res = await call(db);

    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    if (!res.ok) expect(res.error).toContain("tidak punya order aktif");
  });

  // Nadya's shape: portions still to eat, every one of them already dated. The
  // bot has already promised the dates by the time this runs, so somebody has
  // to be told it did not happen.
  test("a customer whose whole package is already dated books nothing and raises an admin push", async () => {
    (loadCustomerSchedule as jest.Mock).mockResolvedValue({ unbooked: 0 });
    const { db, inserted } = makeDb({ orders: { data: [ORDER], error: null } });
    const res = await call(db);

    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      expect.stringContaining("tidak tercatat"),
      expect.any(String),
      "/deliveries",
      "high",
    );
  });

  // The model schedules straight through a libur nasional even with the holiday
  // list in its prompt. Dropping the date here is the guarantee.
  test("a run made entirely of libur nasional books nothing and names the holiday", async () => {
    const { db, inserted } = makeDb({ orders: { data: [ORDER], error: null } });
    const res = await call(db, { delivery_dates: ["2026-12-25"] });

    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    if (!res.ok) expect(res.error).toContain("Kelahiran Yesus Kristus");
  });

  test("a holiday inside a run drops that date and books the rest", async () => {
    const { db, inserted } = makeDb({ orders: { data: [ORDER], error: null } });
    const res = await call(db, {
      delivery_dates: ["2026-12-23", "2026-12-25", "2026-12-26"],
    });

    expect(res.ok).toBe(true);
    expect(inserted.map((r) => r.delivery_date)).toEqual([
      "2026-12-23",
      "2026-12-26",
    ]);
    if (res.ok) {
      expect(res.message).toContain("TIDAK tercatat");
      expect(res.message).toContain("2026-12-25");
    }
  });

  // The model re-states a schedule while confirming it, so the same dates
  // arrive twice.
  test("dates already on the sheet are not double-booked", async () => {
    const { db, inserted } = makeDb({
      orders: { data: [ORDER], error: null },
      daily_deliveries: {
        data: [{ delivery_date: "2026-09-01" }],
        error: null,
      },
    });
    const res = await call(db);

    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    if (!res.ok) expect(res.error).toContain("sudah ada di jadwal");
  });

  // portions is per date, so a multi-day request must not be the thing that
  // pushes an order past what the customer bought.
  test("a run longer than the quota books what it can and names what it dropped", async () => {
    (loadCustomerSchedule as jest.Mock).mockResolvedValue({ unbooked: 4 });
    const { db, inserted } = makeDb({ orders: { data: [ORDER], error: null } });
    const res = await call(db, {
      delivery_dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
      portions: 2,
    });

    expect(inserted.map((r) => r.delivery_date)).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toContain("2026-09-03 (kuota tidak cukup)");
      // 4 unbooked, 2 dates × 2 portions written, nothing left.
      expect(res.message).toContain("setelah ini: 0");
    }
    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      expect.stringContaining("Kuota kurang"),
      expect.any(String),
      "/deliveries",
      "high",
    );
  });

  // Confirming a booking that failed to write is the failure this whole return
  // type exists to stop.
  test("an insert error is reported as a failure, not as a booking", async () => {
    const { db } = makeDb({
      orders: { data: [ORDER], error: null },
      insertError: { message: "deadlock detected" },
    });
    const res = await call(db);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Gagal menyimpan");
    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      expect.stringContaining("GAGAL"),
      expect.stringContaining("deadlock detected"),
      "/deliveries",
      "high",
    );
  });

  // pickDrawOrder, not query order: 85 customers hold two or more active
  // orders, and the row belongs to the oldest one that still has undated
  // portions.
  test("rows are charged to the oldest order with quota left, not the newest", async () => {
    const older = { ...ORDER, id: "older", created_at: "2026-07-01T00:00:00Z" };
    const newer = { ...ORDER, id: "newer", created_at: "2026-08-20T00:00:00Z" };
    (unbookedByOrder as jest.Mock).mockResolvedValue(
      new Map([
        ["older", 5],
        ["newer", 10],
      ]),
    );
    const { db, inserted } = makeDb({
      orders: { data: [newer, older], error: null },
    });
    const res = await call(db);

    expect(res.ok).toBe(true);
    expect(inserted[0].order_id).toBe("older");
  });

  test("the booked rows carry the meal type, portions, kitchen and notes", async () => {
    const { db, inserted } = makeDb({ orders: { data: [ORDER], error: null } });
    await call(db, { meal_type: "dinner", portions: 3, notes: "pedas" });

    expect(inserted[0]).toMatchObject({
      order_id: "order-1",
      customer_id: "cust-1",
      delivery_date: "2026-09-01",
      meal_type: "dinner",
      portions: 3,
      subcontractor_id: "sub-1",
      notes: "pedas",
    });
  });
});
