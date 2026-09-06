import { createOrderFromExtraction } from "@/lib/claude/extract-order";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/claude/classify-address", () => ({
  classifyAddress: jest.fn().mockResolvedValue("house"),
}));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(async (key: string) =>
    key === "size_m_surcharge" ? "4000" : "X",
  ),
  getActiveInstructions: jest.fn().mockResolvedValue([]),
  getExcludedNeighborhoods: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/push/send", () => ({
  sendPushToAllAdmins: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/audit/log-edit", () => ({
  logEdit: jest.fn().mockResolvedValue(undefined),
  systemActor: (name: string) => `system:${name}`,
}));
jest.mock("@/lib/claude/conversation", () => ({
  saveMessage: jest.fn().mockResolvedValue("conv-1"),
  updateMessageReceipt: jest.fn().mockResolvedValue(undefined),
  loadHistory: jest.fn().mockResolvedValue([]),
}));

const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";
const PHONE = "+6285155005163";
/** Suplir, Rp 29.000 at the 5-porsi tier — the order's own dapur. */
const SUPLIR = "d0000000-0000-4000-8000-00000000000a";
/** Palem, Rp 30.500. */
const PALEM = "d0000000-0000-4000-8000-00000000000b";
/** Not active, so a slot naming it falls back to the order's dapur. */
const GHOST = "d0000000-0000-4000-8000-00000000000c";

const RATES: Record<string, number> = {
  [SUPLIR]: 29000,
  [PALEM]: 30500,
};

type Write = { table: string; op: string; payload: unknown };

function mockDb() {
  const writes: Write[] = [];
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let op = "select";
    const chain: Record<string, unknown> = {};
    for (const method of [
      "select",
      "neq",
      "in",
      "not",
      "is",
      "gte",
      "lte",
      "gt",
      "lt",
      "like",
      "ilike",
      "order",
      "limit",
      "range",
    ]) {
      chain[method] = () => chain;
    }
    chain.eq = (col: string, value: unknown) => {
      filters[col] = value;
      return chain;
    };
    for (const method of ["insert", "update", "upsert", "delete"]) {
      chain[method] = (body: unknown) => {
        op = method;
        writes.push({ table, op: method, payload: body });
        return chain;
      };
    }
    const result = () => {
      if (table === "customers" && op === "select")
        return {
          id: CUSTOMER_ID,
          name: "Veronica",
          google_maps_link: "https://maps.app.goo.gl/testlink",
        };
      if (table === "orders")
        return { id: "0d000000-0000-4000-8000-00000000000a", created_at: null };
      if (table === "subcontractors")
        return { id: filters.id, offers_size_m: false };
      if (table === "conversations" && filters.role === "assistant") return null;
      if (table === "pricing_tiers")
        return {
          portions: 5,
          price_per_portion:
            RATES[filters.subcontractor_id as string] ?? RATES[SUPLIR],
        };
      return { id: "00000000-0000-4000-8000-0000000000ff" };
    };
    chain.maybeSingle = async () => ({ data: result(), error: null });
    chain.single = async () => ({ data: result(), error: null });
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) => {
      // The active-kitchen allowlist: the two real dapur, never GHOST.
      if (table === "subcontractors" && filters.is_active === true)
        return resolve({
          data: [{ id: SUPLIR }, { id: PALEM }],
          error: null,
        });
      return resolve({ data: [result()], error: null });
    };
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return writes;
}

beforeEach(() => {
  jest.clearAllMocks();
  (sendTextMessage as jest.Mock).mockResolvedValue("wamid.TEST");
});

const slot = (date: string, subcontractor_id?: string) => ({
  date,
  meal_type: "dinner",
  portions: 1,
  ...(subcontractor_id ? { subcontractor_id } : {}),
});

const BASE = {
  customer_name: "Veronica",
  package_size: 5,
  portions_per_delivery: 1,
  address: "Alam Sutera Cluster Sutera Onyx",
  maps_link: "",
  area: "Alam Sutera",
  subcontractor_id: SUPLIR,
};

function orderWrite(writes: Write[]) {
  return writes.find((w) => w.table === "orders") as Write | undefined;
}

type StoredSlot = {
  date: string;
  meal_type: string;
  portions: number;
  subcontractor_id?: string;
  price_per_portion?: number;
};

function storedSchedule(writes: Write[]): StoredSlot[] {
  const payload = orderWrite(writes)?.payload as {
    requested_schedule: StoredSlot[] | null;
  };
  return payload.requested_schedule ?? [];
}

describe("a package split across dapur", () => {
  it("bills each day at the dapur that cooks it", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [
        slot("2026-09-08"),
        slot("2026-09-09"),
        slot("2026-09-10"),
        slot("2026-09-11", PALEM),
        slot("2026-09-12", PALEM),
      ],
    });

    // 3 x Rp 29.000 + 2 x Rp 30.500. Pricing the whole package at either rate
    // would be Rp 145.000 or Rp 152.500 — one of them a loss on every Palem
    // portion, the other an overcharge on every Suplir one.
    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 29000,
      total_price: 148000,
    });
  });

  it("writes the away days' dapur and rate onto the schedule, and leaves the rest bare", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [
        slot("2026-09-08"),
        slot("2026-09-09", PALEM),
        slot("2026-09-10"),
        slot("2026-09-11"),
        slot("2026-09-12"),
      ],
    });

    const sched = storedSchedule(writes);
    expect(sched[0]).toEqual({
      date: "2026-09-08",
      meal_type: "dinner",
      portions: 1,
    });
    expect(sched[1]).toEqual({
      date: "2026-09-09",
      meal_type: "dinner",
      portions: 1,
      subcontractor_id: PALEM,
      price_per_portion: 30500,
    });
  });

  it("ignores a dapur id that is not an active kitchen", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [
        slot("2026-09-08"),
        slot("2026-09-09"),
        slot("2026-09-10"),
        slot("2026-09-11"),
        slot("2026-09-12", GHOST),
      ],
    });

    // The model invents UUIDs. An invented one prices off an empty ladder at
    // Rp 0 if it is trusted, so it falls back to the order's own dapur.
    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 29000,
      total_price: 145000,
    });
    expect(
      storedSchedule(writes).some((s) => s.subcontractor_id === GHOST),
    ).toBe(false);
  });

  it("prices an unsplit package exactly as before", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [
        slot("2026-09-08"),
        slot("2026-09-09"),
        slot("2026-09-10"),
        slot("2026-09-11"),
        slot("2026-09-12"),
      ],
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 29000,
      total_price: 145000,
    });
    for (const s of storedSchedule(writes)) {
      expect(s.subcontractor_id).toBeUndefined();
      expect(s.price_per_portion).toBeUndefined();
    }
  });
});
