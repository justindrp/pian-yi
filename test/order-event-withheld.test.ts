import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import {
  createOrderFromExtraction,
  looksLikeEventOrder,
} from "@/lib/claude/extract-order";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/claude/classify-address", () => ({
  classifyAddress: jest.fn().mockResolvedValue("house"),
}));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(async (key: string) =>
    key === "event_order_min_portions" ? "15" : "X",
  ),
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
const PHONE = "+6282213672840";

/** Permissive stub: only the gate is under test. */
function mockDb(contractPrice: number | null = null) {
  const touched: string[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000ff",
    name: "Rina",
    portions: 20,
    price_per_portion: 29000,
    delivery_areas: ["Gading Serpong"],
    google_maps_link: "https://maps.app.goo.gl/aBcD1234",
    contract_price_per_portion: contractPrice,
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
  customer_name: "Rina",
  package_size: 20,
  portions_per_delivery: 20,
  address: "The Breeze BSD, lobby halte",
  maps_link: "https://maps.app.goo.gl/aBcD1234",
  area: "Gading Serpong",
  delivery_schedule: [{ date: "2026-09-19", meal_type: "lunch", portions: 20 }],
};

describe("looksLikeEventOrder", () => {
  it("is an event when the whole count lands on one date at or above the floor", () => {
    expect(looksLikeEventOrder(BASE, 15)).toBe(true);
  });

  it("is not an event below the floor", () => {
    expect(
      looksLikeEventOrder(
        {
          ...BASE,
          delivery_schedule: [
            { date: "2026-09-19", meal_type: "lunch", portions: 12 },
          ],
        },
        15,
      ),
    ).toBe(false);
  });

  // 20 portions a day for nine days is a real subscription — the largest one we
  // hold. A run of dates is never an event, however big the package.
  it("is not an event when the portions are spread across dates", () => {
    expect(
      looksLikeEventOrder(
        {
          ...BASE,
          package_size: 180,
          delivery_schedule: [
            { date: "2026-09-19", meal_type: "lunch", portions: 20 },
            { date: "2026-09-20", meal_type: "lunch", portions: 20 },
          ],
        },
        15,
      ),
    ).toBe(false);
  });

  // The day-by-day booker has named no date at all, so nothing about their
  // package shape says event.
  it("is not an event when the schedule is empty", () => {
    expect(looksLikeEventOrder({ ...BASE, delivery_schedule: [] }, 15)).toBe(
      false,
    );
  });

  // Lunch and dinner at one venue on one date is still one event.
  it("sums both meals on the same date", () => {
    expect(
      looksLikeEventOrder(
        {
          ...BASE,
          delivery_schedule: [
            { date: "2026-09-19", meal_type: "lunch", portions: 8 },
            { date: "2026-09-19", meal_type: "dinner", portions: 8 },
          ],
        },
        15,
      ),
    ).toBe(true);
  });
});

describe("createOrderFromExtraction — an event is withheld and tendered", () => {
  it("creates no order, sends no bank details, and parks the question", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    expect(touched).not.toContain("orders");
    expect(touched).not.toContain("daily_deliveries");
    expect(touched).toContain("customer_flags");

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(PHONE);
    // The whole point: creating the order is what sends the bank details.
    expect(text).not.toMatch(/transfer|BCA|Nominal|Rp/i);
    expect(text).toMatch(/dapur/i);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: "assistant" }),
    );
    expect(updateMessageReceipt).toHaveBeenCalled();
    expect(sendPushToAllAdmins).toHaveBeenCalled();
  });

  it("creates the order when the same count is spread across dates", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [
        { date: "2026-09-19", meal_type: "lunch", portions: 10 },
        { date: "2026-09-20", meal_type: "lunch", portions: 10 },
      ],
    });

    expect(touched).toContain("orders");
  });

  // The money has already moved; refusing would throw away a real payment.
  it("still creates the order on the payment-proof path", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(
      CUSTOMER_ID,
      PHONE,
      { ...BASE },
      { sendPaymentInfo: false },
    );

    expect(touched).toContain("orders");
  });

  // A negotiated rate is the price whatever shape the order arrives in.
  it("still creates the order for a contract customer", async () => {
    const touched = mockDb(24000);

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    expect(touched).toContain("orders");
  });
});
