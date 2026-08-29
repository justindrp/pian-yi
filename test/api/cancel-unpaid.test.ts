import { NextRequest } from "next/server";
import { POST } from "@/app/api/cron/cancel-unpaid/route";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteDelivery } from "@/lib/orders/delivery-state";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/audit/log-edit", () => ({
  logEdit: jest.fn(),
  systemActor: (job: string) => `system:${job}`,
}));
jest.mock("@/lib/push/send", () => ({ sendPushToAllAdmins: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({ sendTextMessage: jest.fn() }));
jest.mock("@/lib/orders/delivery-state", () => ({ deleteDelivery: jest.fn() }));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(),
  getTemplate: jest.fn(),
}));

const SECRET = "test-cron-secret";
type Row = Record<string, unknown>;
type Result = { data?: Row[] | null; error: { message: string } | null };

/**
 * The route awaits two different chains off the same table: the order query
 * (`select → eq → lt → lte`) and the cancellation (`update → eq`). Each chain's
 * last call is the one that resolves — `.lte()` for the query, and `.eq()` for
 * the update, which is why `.eq()` only returns a promise once `.update()` has
 * run. `filters` records the query's `.lte()` arguments so a test can assert
 * which `start_date` ceiling the route asked for.
 *
 * The row sweep adds a third chain: `select → eq → gte` against
 * `daily_deliveries`, resolving on `.gte()`. Only that chain calls `.gte()`,
 * so one shared chain object still serves all three.
 */
function makeDb(spec: {
  select: Result;
  update?: Result;
  deliveries?: Result;
}) {
  const updates: Row[] = [];
  const filters: { column: string; value: unknown }[] = [];
  const from = jest.fn(() => {
    let updating = false;
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.lt = jest.fn().mockReturnValue(chain);
    chain.gte = jest.fn(() =>
      Promise.resolve(spec.deliveries ?? { data: [], error: null }),
    );
    chain.lte = jest.fn((column: string, value: unknown) => {
      filters.push({ column, value });
      return Promise.resolve(spec.select);
    });
    chain.update = jest.fn((row: Row) => {
      updates.push(row);
      updating = true;
      return chain;
    });
    chain.eq = jest.fn(() =>
      updating ? Promise.resolve(spec.update ?? { error: null }) : chain,
    );
    return chain;
  });
  return { db: { from }, updates, filters };
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/cron/cancel-unpaid", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

const order = (id: string, phone: string): Row => ({
  id,
  customer_id: `cust-${id}`,
  package_size: 20,
  total_price: 540000,
  start_date: "2026-08-31",
  confirmed_at: "2026-08-24T05:12:35Z",
  customers: { phone_number: phone },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  (getSetting as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(key === "order_deadline_hour" ? "16" : "24"),
  );
  (getTemplate as jest.Mock).mockResolvedValue("pembayaran belum kami terima");
});

describe("cancel-unpaid", () => {
  // The regression. The route asked for `customers(phone_number)` with no FK
  // hint; `orders` reaches `customers` two ways, so PostgREST rejected the
  // whole request with PGRST201. The error was discarded, `orders` came back
  // null, and the empty-result branch returned `ok: true` — which the scheduler
  // recorded as a successful run. It ran hourly for months and cancelled
  // nothing, because a broken query is indistinguishable from a business with
  // no unpaid orders unless the error is actually read.
  it("fails loudly when the order query errors, instead of reporting success", async () => {
    const { db, updates } = makeDb({
      select: {
        data: null,
        error: {
          message:
            "Could not embed because more than one relationship was found for 'orders' and 'customers'",
        },
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("cancels every overdue unpaid order", async () => {
    const { db, updates } = makeDb({
      select: {
        data: [order("a", "+628111"), order("b", "+628222")],
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const body = await (await POST(req())).json();

    expect(body).toMatchObject({ ok: true, cancelled: 2 });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ status: "cancelled_unpaid" });
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it("does not count an order whose update failed", async () => {
    const { db } = makeDb({
      select: { data: [order("a", "+628111")], error: null },
      update: { error: { message: "row locked" } },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const body = await (await POST(req())).json();

    expect(body).toMatchObject({ ok: true, cancelled: 0 });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("reports zero without erroring when nothing is overdue", async () => {
    const { db } = makeDb({ select: { data: [], error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: 0 });
  });

  // Payment is due against the first delivery, not against the chat. Naya
  // confirmed on 24 Aug for a 31 Aug start and Cindi on 21 Aug for a 2 Sep
  // start; both had been told "boleh bayar H-1 atau hari H", and the old
  // age-only sweep cancelled them anyway, a week before they owed anything.
  // The first working run cancelled three orders and `edit_log` recorded none
  // of them, so what the cron had done was reconstructable only from its source.
  it("records every cancellation it makes in edit_log", async () => {
    const { db } = makeDb({
      select: { data: [order("a", "+628111")], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(req());

    expect(logEdit).toHaveBeenCalledTimes(1);
    expect(logEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "system:cancel-unpaid",
        entityType: "order",
        entityId: "a",
        action: "cancel",
        changes: expect.objectContaining({
          status: { from: "pending_payment", to: "cancelled_unpaid" },
        }),
      }),
    );
  });

  // The audit row follows the business write, so an order that never moved must
  // not leave a trail saying it did.
  it("does not log a cancellation whose update failed", async () => {
    const { db } = makeDb({
      select: { data: [order("a", "+628111")], error: null },
      update: { error: { message: "row locked" } },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(req());

    expect(logEdit).not.toHaveBeenCalled();
  });

  it("only sweeps orders whose start date has reached the H-1 deadline", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T10:00:00Z")); // 17:00 WIB
    const { db, filters } = makeDb({ select: { data: [], error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(req());

    expect(filters).toEqual([{ column: "start_date", value: "2026-08-28" }]);
    jest.useRealTimers();
  });

  // Before the deadline an H-1 payer still has the rest of the day, so the
  // hourly runs before 16:00 WIB must not reach tomorrow's starters.
  it("leaves tomorrow's starters alone until the deadline passes", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T02:00:00Z")); // 09:00 WIB
    const { db, filters } = makeDb({ select: { data: [], error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(req());

    expect(filters).toEqual([{ column: "start_date", value: "2026-08-27" }]);
    jest.useRealTimers();
  });

  // The other half of a cancellation. `orders.status` moved and nothing else
  // did, so the cancelled order's meals stayed on the kitchen sheet — which
  // keys on `delivery_date` alone and never joins order status — and a kitchen
  // would have cooked portions nobody paid for.
  it("takes the order's undelivered rows off the sheet with it", async () => {
    const { db } = makeDb({
      select: { data: [order("a", "+628111")], error: null },
      deliveries: { data: [{ id: "row-1" }, { id: "row-2" }], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(req());
    const body = await res.json();

    expect(body.deliveriesRemoved).toBe(2);
    expect(body.deliveriesStuck).toBe(0);
    expect(deleteDelivery).toHaveBeenCalledTimes(2);
    expect((deleteDelivery as jest.Mock).mock.calls[0][0]).toMatchObject({
      id: "row-1",
      actor: "system:cancel-unpaid",
    });
  });

  // A row in the past is food that was already cooked and delivered. Deleting
  // it would erase a real cost from the books to make an unpaid order tidy, so
  // the sweep asks for today onwards and nothing earlier.
  it("only asks for rows from today onwards", async () => {
    const { db } = makeDb({
      select: { data: [order("a", "+628111")], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await POST(req());

    const gte = (db.from as jest.Mock).mock.results
      .flatMap((r) => (r.value as { gte: jest.Mock }).gte.mock.calls)
      .filter((c) => c.length > 0);
    expect(gte[0][0]).toBe("delivery_date");
    expect(gte[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The order is already cancelled by the time a row is deleted, so a failure
  // here must not swallow the customer's notice or drop the order out of the
  // count. It must still be loud: a cancelled order with live rows is exactly
  // the bug this block exists to prevent.
  it("still notifies the customer when a row will not delete, and says so", async () => {
    const { db } = makeDb({
      select: { data: [order("a", "+628111")], error: null },
      deliveries: { data: [{ id: "row-1" }], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    (deleteDelivery as jest.Mock).mockRejectedValueOnce(
      new Error("delivery_proofs violates foreign key constraint"),
    );

    const res = await POST(req());
    const body = await res.json();

    expect(body.cancelled).toBe(1);
    expect(body.deliveriesRemoved).toBe(0);
    expect(body.deliveriesStuck).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects a request without the cron secret", async () => {
    const { db } = makeDb({ select: { data: [], error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      new NextRequest("http://localhost/api/cron/cancel-unpaid", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(401);
  });
});
