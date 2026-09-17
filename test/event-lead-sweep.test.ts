import type { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/event-lead-sweep/route";
import { getSetting } from "@/lib/cache/settings";
import { upsertEventLead } from "@/lib/events/leads";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/push/send", () => ({ sendPushToAllAdmins: jest.fn() }));
jest.mock("@/lib/cache/settings", () => ({ getSetting: jest.fn() }));

const SECRET = "test-cron-secret";

type Row = Record<string, unknown>;

const updates: Row[] = [];
const inserts: Row[] = [];

/**
 * The route awaits the builder itself after `.order()` and after `.in()`, so
 * the chain IS a promise with the filter methods hung off it — rather than an
 * object carrying a `then`, which is a thenable Biome rightly refuses.
 */
function makeDb(spec: { event_leads?: Row[]; customers?: Row[] }) {
  const from = jest.fn((table: string) => {
    const rows = (spec[table as keyof typeof spec] as Row[] | undefined) ?? [];
    const chain = Promise.resolve({ data: rows, error: null }) as Promise<{
      data: Row[];
      error: null;
    }> &
      Record<string, unknown>;
    for (const m of ["select", "eq", "in", "not", "lte", "order", "limit"]) {
      chain[m] = jest.fn(() => chain);
    }
    chain.update = jest.fn((patch: Row) => {
      updates.push(patch);
      const w: Record<string, unknown> = {};
      for (const m of ["in", "eq"])
        w[m] = jest.fn(() => Promise.resolve({ error: null }));
      return w;
    });
    chain.insert = jest.fn((row: Row) => {
      inserts.push(row);
      return Promise.resolve({ error: null });
    });
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return from;
}

function req(): NextRequest {
  return new Request("http://localhost/api/cron/event-lead-sweep", {
    headers: { "x-cron-secret": SECRET },
  }) as unknown as NextRequest;
}

/** Today in WIB, which is what the route compares dates against. */
function wibToday(offsetDays = 0): string {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe("event-lead-sweep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    inserts.length = 0;
    process.env.CRON_SECRET = SECRET;
    (getSetting as jest.Mock).mockResolvedValue("3");
  });

  it("refuses without the cron secret", async () => {
    const res = await GET(
      new Request("http://localhost/api/cron/event-lead-sweep") as never,
    );
    expect(res.status).toBe(401);
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
  });

  it("pushes once for every lead due today and stamps them", async () => {
    makeDb({
      event_leads: [
        {
          id: "l1",
          customer_id: "c1",
          event_date: wibToday(1),
          portions: 20,
          status: "quoted",
          last_nudged_at: null,
        },
        {
          id: "l2",
          customer_id: "c2",
          event_date: wibToday(-1),
          portions: 40,
          status: "tendered",
          last_nudged_at: null,
        },
      ],
      customers: [
        { id: "c1", name: "Rina", phone_number: "+628111" },
        { id: "c2", name: null, phone_number: "+628222" },
      ],
    });

    const res = await GET(req());
    const json = await res.json();
    expect(json.data.nudged).toBe(2);
    // One push for both, not one each.
    expect(sendPushToAllAdmins).toHaveBeenCalledTimes(1);
    const body = (sendPushToAllAdmins as jest.Mock).mock.calls[0][1] as string;
    expect(body).toContain("Rina");
    expect(body).toContain("+628222");
    // A date already gone is named as such, because it still needs closing.
    expect(body).toContain("sudah lewat");
    expect(updates[0].last_nudged_at).toBeTruthy();
  });

  it("says nothing twice in one day", async () => {
    makeDb({
      event_leads: [
        {
          id: "l1",
          customer_id: "c1",
          event_date: wibToday(2),
          portions: 20,
          status: "brief",
          last_nudged_at: new Date().toISOString(),
        },
      ],
      customers: [{ id: "c1", name: "Rina", phone_number: "+628111" }],
    });

    const res = await GET(req());
    expect((await res.json()).data.nudged).toBe(0);
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("speaks again the next day", async () => {
    const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    makeDb({
      event_leads: [
        {
          id: "l1",
          customer_id: "c1",
          event_date: wibToday(1),
          portions: 20,
          status: "quoted",
          last_nudged_at: yesterday,
        },
      ],
      customers: [{ id: "c1", name: "Rina", phone_number: "+628111" }],
    });

    expect((await (await GET(req())).json()).data.nudged).toBe(1);
  });
});

describe("upsertEventLead", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    inserts.length = 0;
  });

  it("inserts when the customer holds no open lead", async () => {
    makeDb({ event_leads: [] });
    await upsertEventLead({
      customerId: "c1",
      eventDate: "2026-10-01",
      portions: 70,
      venue: "The Breeze",
      brief: "70 porsi",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      customer_id: "c1",
      event_date: "2026-10-01",
      status: "brief",
    });
  });

  it("refines the open lead rather than opening a second one", async () => {
    makeDb({
      event_leads: [
        {
          id: "l1",
          event_date: "2026-10-01",
          portions: 70,
          venue: "The Breeze",
          brief: "70 porsi",
        },
      ],
    });
    await upsertEventLead({
      customerId: "c1",
      eventDate: "2026-10-01",
      portions: 80,
      venue: null,
      brief: "80 porsi",
    });
    expect(inserts).toHaveLength(0);
    expect(updates[0]).toMatchObject({ portions: 80 });
    // A call that omitted the address must not erase the one we have.
    expect(updates[0].venue).toBe("The Breeze");
  });

  it("opens a second lead for a different date", async () => {
    makeDb({
      event_leads: [
        {
          id: "l1",
          event_date: "2026-10-01",
          portions: 70,
          venue: null,
          brief: null,
        },
      ],
    });
    await upsertEventLead({
      customerId: "c1",
      eventDate: "2026-11-20",
      portions: 30,
      venue: null,
      brief: null,
    });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });
});
