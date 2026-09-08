import { createOrderFromExtraction } from "@/lib/claude/extract-order";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/claude/classify-address", () => ({
  classifyAddress: jest.fn().mockResolvedValue("house"),
}));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn().mockResolvedValue("X"),
  getActiveInstructions: jest.fn().mockResolvedValue([]),
  getExcludedNeighborhoods: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/push/send", () => ({
  sendPushToAllAdmins: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/claude/conversation", () => ({
  saveMessage: jest.fn().mockResolvedValue("conv-1"),
  updateMessageReceipt: jest.fn().mockResolvedValue(undefined),
  loadHistory: jest.fn().mockResolvedValue([]),
}));

const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";
const PHONE = "+6285241234812";

/**
 * Same permissive stub as order-sellable-size, with one addition: the customer
 * has said "5 porsi" in the chat, which is what `statedTotal` reads.
 */
function mockDb(said: string) {
  const written: Record<string, unknown>[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000ff",
    name: "Ireine Roosdy",
    portions: 5,
    price_per_portion: 29000,
    delivery_areas: ["Alam Sutera"],
    google_maps_link: "https://maps.app.goo.gl/testlink",
    content: said,
    role: "user",
  };
  const from = jest.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of [
      "select",
      "eq",
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
      "upsert",
      "delete",
    ]) {
      chain[method] = () => chain;
    }
    // The stub answers every select, so the customer always has an open
    // pending_payment order and `extract_order` amends it rather than inserting
    // a second one — which is the rule. Both writes carry package_size.
    for (const method of ["insert", "update"]) {
      chain[method] = (payload: Record<string, unknown>) => {
        if (table === "orders") written.push(payload);
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: row, error: null });
    chain.single = async () => ({ data: row, error: null });
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [row], error: null });
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return written;
}

beforeEach(() => {
  jest.clearAllMocks();
  (sendTextMessage as jest.Mock).mockResolvedValue("wamid.TEST");
});

const BASE = {
  customer_name: "Ireine Roosdy",
  portions_per_delivery: 5,
  address: "Pacific Garden Apartment TC 15/19-21",
  maps_link: "https://maps.app.goo.gl/testlink",
  area: "Alam Sutera",
};

/** Five weekdays, five portions each: 25 portions. */
const FIVE_DAYS = [
  { date: "2026-09-10", meal_type: "lunch", portions: 5 },
  { date: "2026-09-11", meal_type: "lunch", portions: 5 },
  { date: "2026-09-14", meal_type: "lunch", portions: 5 },
  { date: "2026-09-15", meal_type: "lunch", portions: 5 },
  { date: "2026-09-16", meal_type: "lunch", portions: 5 },
];

describe("a named schedule outranks a bare number in the chat", () => {
  // Ireine Roosdy, 2026-09-08: "5 porsi" meant five per day, and she then named
  // five days. The order was written for 5 against a schedule summing to 25 —
  // Rp 145.000 of bank details for a Rp 675.000 package.
  it("sums the schedule rather than reading the customer's per-day count", async () => {
    const written = mockDb("5 porsi");

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      package_size: 5,
      delivery_schedule: FIVE_DAYS,
    });

    expect(written).toHaveLength(1);
    expect(written[0].package_size).toBe(25);
  });

  // The Tiwi case the override exists for: no schedule, so the last number the
  // customer typed is still the size.
  it("keeps reading the stated total when no days were named", async () => {
    const written = mockDb("Boleh 6 porsi dulu kak");

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      portions_per_delivery: 1,
      package_size: 8,
      delivery_schedule: [],
    });

    expect(written).toHaveLength(1);
    expect(written[0].package_size).toBe(6);
  });
});
