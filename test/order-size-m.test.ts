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

const NOW = "2026-08-29T00:00:00.000Z";
const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";
const PHONE = "+6285155005162";
const DAPUR_M = "d0000000-0000-4000-8000-000000000001";
const DAPUR_S = "d0000000-0000-4000-8000-000000000002";

type Write = { table: string; op: string; payload: unknown };

/** Enough of the PostgREST builder to walk `createOrderFromExtraction`. */
function mockDb(offersM: Record<string, boolean>) {
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
        return { id: CUSTOMER_ID, name: "Naya" };
      if (table === "orders")
        return { id: "0d000000-0000-4000-8000-000000000001", created_at: NOW };
      if (table === "subcontractors")
        return {
          id: filters.id,
          offers_size_m: offersM[filters.id as string] === true,
        };
      if (table === "conversations" && filters.role === "assistant")
        return null;
      // 20 porsi at the 20-hari siang/malam rate.
      if (table === "pricing_tiers")
        return { portions: 20, price_per_portion: 27000 };
      return { id: "00000000-0000-4000-8000-0000000000ff" };
    };
    chain.maybeSingle = async () => ({ data: result(), error: null });
    chain.single = async () => ({ data: result(), error: null });
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [result()], error: null });
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
  customer_name: "Naya",
  package_size: 20,
  portions_per_delivery: 1,
  address: "Cluster Allogio Timur 3 No.32",
  maps_link: "",
  area: "Gading Serpong",
  delivery_schedule: [] as {
    date: string;
    meal_type: string;
    portions: number;
  }[],
};

function orderWrite(writes: Write[]) {
  return writes.find((w) => w.table === "orders") as Write | undefined;
}

describe("size M on a new order", () => {
  it("charges the surcharge on top of the tier and records the size", async () => {
    const writes = mockDb({ [DAPUR_M]: true });

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: DAPUR_M,
      size: "m",
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      size: "m",
      price_per_portion: 31000,
      total_price: 620000,
    });
  });

  it("writes S, at the S price, for a dapur that does not cook M", async () => {
    // The prompt only offers M where a kitchen has it, but a model that offers
    // it anyway must not put an M row on a kitchen that cooks S: the customer
    // would have paid the surcharge for a dish nobody made. Write S rather
    // than refuse, so the order still exists and the price matches the food.
    const writes = mockDb({ [DAPUR_M]: true });

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: DAPUR_S,
      size: "m",
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      size: "s",
      price_per_portion: 27000,
      total_price: 540000,
    });
  });

  it("leaves an ordinary order on the S price", async () => {
    const writes = mockDb({ [DAPUR_M]: true });

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      subcontractor_id: DAPUR_M,
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      size: "s",
      price_per_portion: 27000,
      total_price: 540000,
    });
  });
});
