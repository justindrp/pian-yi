import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/renewal-reminders/route";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { remainingTodayByOrder } from "@/lib/orders/customer-schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({ sendTextMessage: jest.fn() }));
jest.mock("@/lib/orders/customer-schedule", () => ({
  remainingTodayByOrder: jest.fn(),
}));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(),
  getTemplate: jest.fn(),
}));

const SECRET = "test-cron-secret";
type Row = Record<string, unknown>;

/**
 * Both chains the route uses end on `.eq()` — the order query is
 * `select → eq("status")` and the write is `update → eq("id")` — so the same
 * `updating` flag trick as `cancel-unpaid.test.ts` decides which one resolves.
 */
function makeDb(rows: Row[]) {
  const updates: { id: unknown; row: Row }[] = [];
  const from = jest.fn(() => {
    let pending: Row | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.update = jest.fn((row: Row) => {
      pending = row;
      return chain;
    });
    chain.eq = jest.fn((_column: string, value: unknown) => {
      if (pending) {
        updates.push({ id: value, row: pending });
        pending = null;
        return Promise.resolve({ error: null });
      }
      return Promise.resolve({ data: rows, error: null });
    });
    return chain;
  });
  return { db: { from }, updates };
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/cron/renewal-reminders", {
    method: "GET",
    headers: { "x-cron-secret": SECRET },
  });
}

/** An order queued for the *first* reminder: never reminded, quota low. */
const order = (id: string, phone: string, name = id): Row => ({
  id,
  customer_id: `cust-${id}`,
  package_size: 20,
  reminder_sent_at: null,
  followup_sent_at: null,
  customers: { phone_number: phone, name },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  (getSetting as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(key === "low_quota_first_warning" ? "3" : "1"),
  );
  (getTemplate as jest.Mock).mockResolvedValue("sisa kuota {name}: {remaining}");
  (remainingTodayByOrder as jest.Mock).mockImplementation((_db, orders: Row[]) =>
    Promise.resolve(new Map(orders.map((o) => [o.id as string, 0]))),
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
  const { db, updates } = makeDb(rows);
  (createAdminClient as jest.Mock).mockReturnValue(db);
  return updates;
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
    const updates = install([
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
    expect(updates.map((u) => u.id)).toEqual(["a", "c"]);
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

  it("rejects an unauthenticated call", async () => {
    install([]);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/renewal-reminders"),
    );
    expect(res.status).toBe(401);
  });
});
