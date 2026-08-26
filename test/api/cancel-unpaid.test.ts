import { NextRequest } from "next/server";
import { POST } from "@/app/api/cron/cancel-unpaid/route";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
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
 * (`select → eq → lt`) and the cancellation (`update → eq`). Each chain's last
 * call is the one that resolves — `.lt()` for the query, and `.eq()` for the
 * update, which is why `.eq()` only returns a promise once `.update()` has run.
 */
function makeDb(spec: { select: Result; update?: Result }) {
  const updates: Row[] = [];
  const from = jest.fn(() => {
    let updating = false;
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.lt = jest.fn(() => Promise.resolve(spec.select));
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
  return { db: { from }, updates };
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
  customers: { phone_number: phone },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  (getSetting as jest.Mock).mockResolvedValue("24");
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
