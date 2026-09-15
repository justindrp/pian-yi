import {
  createOrderFromExtraction,
  mentionsTanpaNasi,
} from "@/lib/claude/extract-order";
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
/** Suplir, Rp 29.000 at the 5-porsi tier, and no tanpa-nasi discount. */
const SUPLIR = "d0000000-0000-4000-8000-00000000000a";
/** Monstera, Rp 45.000, Rp 4.000 off a box without rice. */
const MONSTERA = "d0000000-0000-4000-8000-00000000000b";

const RATES: Record<string, number> = {
  [SUPLIR]: 29000,
  [MONSTERA]: 45000,
};
const NO_RICE: Record<string, number | null> = {
  [SUPLIR]: null,
  [MONSTERA]: 4000,
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
          kitchen_notes: null,
          google_maps_link: "https://maps.app.goo.gl/testlink",
        };
      if (table === "orders")
        return { id: "0d000000-0000-4000-8000-00000000000a", created_at: null };
      if (table === "subcontractors")
        return {
          id: filters.id,
          offers_size_m: false,
          no_rice_discount: NO_RICE[filters.id as string] ?? null,
        };
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
      if (table === "subcontractors" && filters.is_active === true)
        return resolve({
          data: [{ id: SUPLIR }, { id: MONSTERA }],
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

const BASE = {
  customer_name: "Veronica",
  package_size: 5,
  portions_per_delivery: 1,
  address: "Alam Sutera Cluster Sutera Onyx",
  maps_link: "",
  area: "Alam Sutera",
  delivery_schedule: [],
};

const orderWrite = (writes: Write[]) =>
  writes.find((w) => w.table === "orders") as Write | undefined;
const customerWrite = (writes: Write[]) =>
  writes.find((w) => w.table === "customers" && w.op === "update") as
    | Write
    | undefined;

describe("tanpa nasi is priced from the dapur's own column", () => {
  it("takes the discount off every portion at a dapur that sells one", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: MONSTERA,
      tanpa_nasi: true,
      catatan: "tanpa nasi",
    });

    // Rp 45.000 - Rp 4.000, five portions. The prompt used to say "harga sama"
    // for every dapur, which billed this order Rp 225.000.
    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 41000,
      total_price: 205000,
      no_rice: true,
    });
  });

  it("charges the full rate where the column is null, and still records the request", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: SUPLIR,
      tanpa_nasi: true,
      catatan: "tanpa nasi",
    });

    // Null is "charges the same either way", never "does not sell it".
    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 29000,
      total_price: 145000,
      no_rice: true,
    });
  });

  it("leaves an ordinary order alone", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: MONSTERA,
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 45000,
      no_rice: false,
    });
  });

  it("reads the request out of catatan when the flag was not sent", async () => {
    const writes = mockDb();

    // The words were the only channel for six weeks, so this is the shape to
    // expect from a model that has seen the old rules.
    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: MONSTERA,
      catatan: "tidak pedas, tanpa nasi",
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 41000,
      no_rice: true,
    });
  });

  it("writes the words to the kitchen even when only the flag was sent", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: MONSTERA,
      tanpa_nasi: true,
    });

    // The sheet prints kitchen_notes and nothing else (migration 089): a
    // discounted order that never reaches the cook arrives with rice in it.
    expect(customerWrite(writes)?.payload).toMatchObject({
      kitchen_notes: expect.stringContaining("tanpa nasi"),
    });
  });

  it("prices an away day at that dapur's own discount", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: SUPLIR,
      tanpa_nasi: true,
      catatan: "tanpa nasi",
      delivery_schedule: [
        { date: "2026-09-08", meal_type: "dinner", portions: 1 },
        { date: "2026-09-09", meal_type: "dinner", portions: 1 },
        { date: "2026-09-10", meal_type: "dinner", portions: 1 },
        { date: "2026-09-11", meal_type: "dinner", portions: 1 },
        {
          date: "2026-09-12",
          meal_type: "dinner",
          portions: 1,
          subcontractor_id: MONSTERA,
        },
      ],
    });

    // 4 × Rp 29.000 at Suplir, who take nothing off, plus one day at Monstera's
    // Rp 45.000 less their Rp 4.000.
    expect(orderWrite(writes)?.payload).toMatchObject({
      price_per_portion: 29000,
      total_price: 157000,
    });
  });
});

describe("mentionsTanpaNasi", () => {
  it("reads every phrasing the prompt calls this exception", () => {
    for (const note of [
      "tanpa nasi",
      "tidak pedas, Tanpa Nasi",
      "hanya lauknya",
      "cuma lauk",
      "lauk saja",
      "lauk doang",
      "no rice",
    ])
      expect(mentionsTanpaNasi(note)).toBe(true);
  });

  it("does not read nasi merah or an empty note as one", () => {
    for (const note of [null, "", "nasi merah", "tidak pedas"])
      expect(mentionsTanpaNasi(note)).toBe(false);
  });
});
