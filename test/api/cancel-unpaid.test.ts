import { NextRequest } from "next/server";
import { POST } from "@/app/api/cron/cancel-unpaid/route";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/audit/log-edit", () => ({
  logEdit: jest.fn(),
  systemActor: (job: string) => `system:${job}`,
}));
jest.mock("@/lib/push/send", () => ({ sendPushToAllAdmins: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({ sendTextMessage: jest.fn() }));
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
 */
function makeDb(spec: { select: Result; update?: Result }) {
  const updates: Row[] = [];
  const filters: { column: string; value: unknown }[] = [];
  const from = jest.fn(() => {
    let updating = false;
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.lt = jest.fn().mockReturnValue(chain);
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

    expect(body).toEqual({ ok: true, cancelled: 2 });
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

    expect(body).toEqual({ ok: true, cancelled: 0 });
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
