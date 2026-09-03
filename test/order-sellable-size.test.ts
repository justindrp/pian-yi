import {
  createOrderFromExtraction,
  isSellableSize,
  nearestSellableSizes,
} from "@/lib/claude/extract-order";
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
const PHONE = "+6281234567890";

/** Same permissive stub as order-schedule-required: only the gate is under test. */
function mockDb() {
  const touched: string[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000ff",
    name: "Veronica",
    portions: 5,
    price_per_portion: 29000,
    delivery_areas: ["Gading Serpong"],
    google_maps_link: "https://maps.app.goo.gl/testlink",
  };
  const from = jest.fn((table: string) => {
    touched.push(table);
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
      "insert",
      "update",
      "upsert",
      "delete",
    ]) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = async () => ({ data: row, error: null });
    chain.single = async () => ({ data: row, error: null });
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [row], error: null });
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return touched;
}

beforeEach(() => {
  jest.clearAllMocks();
  (sendTextMessage as jest.Mock).mockResolvedValue("wamid.TEST");
});

const BASE = {
  customer_name: "Veronica",
  portions_per_delivery: 1,
  address: "Cluster Michelia, Jl. Michelia 10 No 35",
  maps_link: "",
  area: "Gading Serpong",
};

/** Senin–Jumat dinner plus Sabtu lunch & dinner: seven deliveries. */
const SEVEN_DAYS = [
  { date: "2026-08-31", meal_type: "dinner", portions: 1 },
  { date: "2026-09-01", meal_type: "dinner", portions: 1 },
  { date: "2026-09-02", meal_type: "dinner", portions: 1 },
  { date: "2026-09-03", meal_type: "dinner", portions: 1 },
  { date: "2026-09-04", meal_type: "dinner", portions: 1 },
  { date: "2026-09-05", meal_type: "lunch", portions: 1 },
  { date: "2026-09-05", meal_type: "dinner", portions: 1 },
];

describe("the sizes we can sell", () => {
  it("counts 5, 6 and multiples of either, and nothing else", () => {
    for (const n of [5, 6, 10, 12, 15, 18, 20, 24, 25, 30, 110, 144]) {
      expect(isSellableSize(n, 5)).toBe(true);
    }
    for (const n of [1, 3, 4, 7, 8, 9, 11, 13, 14, 22]) {
      expect(isSellableSize(n, 5)).toBe(false);
    }
  });

  it("offers the nearest sellable total either side", () => {
    // The pairs the prompt names by hand.
    expect(nearestSellableSizes(7, 5)).toEqual({ below: 6, above: 10 });
    expect(nearestSellableSizes(13, 5)).toEqual({ below: 12, above: 15 });
    expect(nearestSellableSizes(22, 5)).toEqual({ below: 20, above: 24 });
  });

  it("has no total below the floor to offer", () => {
    expect(nearestSellableSizes(4, 5)).toEqual({ below: null, above: 5 });
  });
});

describe("createOrderFromExtraction — a package is never an off-ladder size", () => {
  // Veronica Catherine, 2026-08-30: seven days named, and the model offered
  // "paket 7 porsi (7 × Rp 28.000 = Rp 196.000)" — a size we do not sell, at a
  // rate that is not even the tier-below fallback.
  it("creates no order for 7 porsi and offers 6 or 10 instead", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      package_size: 7,
      delivery_schedule: SEVEN_DAYS,
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(PHONE);
    expect(text).toMatch(/6 porsi/);
    expect(text).toMatch(/10 porsi/);
    // The whole point: no bank details for a package that does not exist.
    expect(text).not.toMatch(/transfer|BCA|Nominal/i);
    expect(touched).not.toContain("orders");
    expect(touched).not.toContain("daily_deliveries");
  });

  // A customer with quota left is right to name more days than the package they
  // are buying: seven days against a 6-porsi top-up is 6 bought plus 1 owned.
  it("takes the extracted size when the schedule sums to one we cannot sell", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      package_size: 6,
      delivery_schedule: SEVEN_DAYS,
    });

    const refused = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /belum ada/.test(text),
    );
    expect(refused).toBe(false);
    expect(touched).toContain("orders");
  });

  // Rachel, 2026-08-31: quoted 4 porsi / Rp 116.000, order written at 5 porsi /
  // Rp 145.000, and the tool result said neither number — so the model kept its
  // own and told her to ignore the amount the system had sent.
  it("hands back the figures the order was actually written with", async () => {
    mockDb();

    const result = await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      package_size: 6,
      delivery_schedule: SEVEN_DAYS,
    });

    expect(result.order).not.toBeNull();
    expect(result.order?.packageSize).toBe(6);
    expect(result.order?.size).toBe("s");
    expect(result.order?.totalPrice).toBe(
      (result.order?.pricePerPortion ?? 0) * 6,
    );
  });

  it("hands back no figures when no order was written", async () => {
    mockDb();

    const result = await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      package_size: 7,
      delivery_schedule: SEVEN_DAYS,
    });

    expect(result.order).toBeNull();
  });

  // Money has already moved on this path; refusing throws away a real payment.
  it("still creates the order when we are not the ones asking for money", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(
      CUSTOMER_ID,
      PHONE,
      { ...BASE, package_size: 7, delivery_schedule: SEVEN_DAYS },
      { sendPaymentInfo: false },
    );

    const refused = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /belum ada/.test(text),
    );
    expect(refused).toBe(false);
    expect(touched).toContain("orders");
  });
});
