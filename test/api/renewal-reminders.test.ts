import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/renewal-reminders/route";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { remainingTodayByCustomer } from "@/lib/orders/customer-schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({ sendTextMessage: jest.fn() }));
jest.mock("@/lib/orders/customer-schedule", () => ({
  remainingTodayByCustomer: jest.fn(),
}));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(),
  getTemplate: jest.fn(),
}));

const SECRET = "test-cron-secret";
type Row = Record<string, unknown>;

/**
 * The order query is `select → eq("status")` and the stamp is
 * `update → in("id", [...])`, so the two chains end on different methods and
 * neither needs the `pending` flag `cancel-unpaid.test.ts` uses.
 */
function makeDb(rows: Row[]) {
  const stamped: { ids: unknown; row: Row }[] = [];
  const from = jest.fn(() => {
    let pending: Row | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.update = jest.fn((row: Row) => {
      pending = row;
      return chain;
    });
    chain.eq = jest.fn(() => Promise.resolve({ data: rows, error: null }));
    chain.in = jest.fn((_column: string, ids: unknown) => {
      stamped.push({ ids, row: pending ?? {} });
      pending = null;
      return Promise.resolve({ error: null });
    });
    return chain;
  });
  return { db: { from }, stamped };
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/cron/renewal-reminders", {
    method: "GET",
    headers: { "x-cron-secret": SECRET },
  });
}

/** An order queued for the *first* reminder: never reminded, quota low. */
const order = (id: string, phone: string, customerId = `cust-${id}`): Row => ({
  id,
  customer_id: customerId,
  reminder_sent_at: null,
  followup_sent_at: null,
  customers: { phone_number: phone, name: id },
});

/** Every customer in `rows` at a low but real balance, unless overridden. */
function balances(entries: [string, number][]) {
  (remainingTodayByCustomer as jest.Mock).mockResolvedValue(new Map(entries));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  (getSetting as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(key === "low_quota_first_warning" ? "3" : "1"),
  );
  (getTemplate as jest.Mock).mockResolvedValue("sisa kuota {name}: {remaining}");
  // At or below the threshold and above zero, which is what earns a reminder.
  (remainingTodayByCustomer as jest.Mock).mockImplementation(
    (_db, ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, 2]))),
  );
  (sendTextMessage as jest.Mock).mockResolvedValue("wamid.OK");
  // Two tests drive sends into the catch on purpose; that logging is the
  // behaviour under test, not something to read in the suite output.
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

function install(rows: Row[]) {
  const { db, stamped } = makeDb(rows);
  (createAdminClient as jest.Mock).mockReturnValue(db);
  return stamped;
}

describe("renewal-reminders", () => {
  it("skips a legacy import placeholder instead of dying on it", async () => {
    // IMPORT_rima sorted to position 0 of the live queue, and the bare send
    // threw there and abandoned the other 242 customers every hour.
    install([
      order("a", "IMPORT_rima"),
      order("b", "+6281320480123"),
      order("c", "+6285174104007"),
    ]);

    const res = await GET(req());
    const body = await res.json();

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).not.toHaveBeenCalledWith(
      "IMPORT_rima",
      expect.anything(),
    );
    expect(body).toMatchObject({ ok: true, firstReminders: 2, unreachable: 1 });
  });

  it("keeps sending after a send throws mid-queue", async () => {
    const stamped = install([
      order("a", "+6281320480123"),
      order("b", "+6285174104007"),
      order("c", "+6287780081705"),
    ]);
    (sendTextMessage as jest.Mock)
      .mockResolvedValueOnce("wamid.OK")
      .mockRejectedValueOnce(new Error("WhatsApp API error 400 (#131009)"))
      .mockResolvedValueOnce("wamid.OK");

    const res = await GET(req());
    const body = await res.json();

    expect(sendTextMessage).toHaveBeenCalledTimes(3);
    expect(body).toMatchObject({ firstReminders: 2, failed: 1 });
    // The failed customer must not be marked reminded, or they never hear again.
    expect(stamped.map((s) => s.ids)).toEqual([["a"], ["c"]]);
  });

  it("treats a DEMO_ number as reachable", async () => {
    // Deliberately not numeric; the client stubs the send. Testing the digits
    // alone would drop every replay customer.
    install([order("a", "DEMO_nadya")]);

    await GET(req());

    expect(sendTextMessage).toHaveBeenCalledWith(
      "DEMO_nadya",
      expect.stringContaining("sisa kuota"),
    );
  });

  it("reports what it sent, not what it queued", async () => {
    install([order("a", "+6281320480123"), order("b", "IMPORT_vivi")]);
    (sendTextMessage as jest.Mock).mockRejectedValue(new Error("boom"));

    const body = await (await GET(req())).json();

    expect(body).toMatchObject({ firstReminders: 0, failed: 1, unreachable: 1 });
  });

  it("quotes the customer's ledger balance, not a per-order one", async () => {
    // The whole reason this route stopped using `remainingTodayByOrder`: that
    // number is `package_size` minus one order's rows, and it goes negative as
    // an ordinary artifact of cross-order draws. It told 306 of 306 queued
    // customers they had 0 or -100 portions left.
    install([order("a", "+6281320480123")]);
    balances([["cust-a", 3]]);

    await GET(req());

    expect(sendTextMessage).toHaveBeenCalledWith(
      "+6281320480123",
      expect.stringContaining("sisa kuota a: 3"),
    );
  });

  it("never writes a zero or negative balance into the message", async () => {
    // A negative customer-level balance is a real over-draw rather than an
    // artifact, and still not a sentence to send anyone.
    install([
      order("neg", "+6281320480123"),
      order("zero", "+6285174104007"),
      order("low", "+6287780081705"),
    ]);
    balances([
      ["cust-neg", -100],
      ["cust-zero", 0],
      ["cust-low", 2],
    ]);

    const body = await (await GET(req())).json();

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "+6287780081705",
      expect.stringContaining("sisa kuota low: 2"),
    );
    expect(body).toMatchObject({ firstReminders: 1 });
  });

  it("sends one message to a customer holding two active orders", async () => {
    // 85 customers do. The balance is customer-level now, so a per-order loop
    // would send the same sentence carrying the same number twice — and stamp
    // only the order it looped on, leaving the other to fire again next hour.
    const stamped = install([
      order("o1", "+6281320480123", "cust-shared"),
      order("o2", "+6281320480123", "cust-shared"),
    ]);
    balances([["cust-shared", 2]]);

    const body = await (await GET(req())).json();

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ firstReminders: 1 });
    // Both orders stamped, or the untouched one re-queues the customer.
    expect(stamped).toEqual([
      { ids: ["o1", "o2"], row: { reminder_sent_at: expect.any(String) } },
    ]);
  });

  it("rejects an unauthenticated call", async () => {
    install([]);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/renewal-reminders"),
    );
    expect(res.status).toBe(401);
  });
});
