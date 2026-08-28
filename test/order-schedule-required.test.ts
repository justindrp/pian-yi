import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
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

/** Same permissive stub as order-name-required: only the gate is under test. */
function mockDb() {
  const touched: string[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000ff",
    name: "Keira",
    portions: 5,
    price_per_portion: 29000,
    delivery_areas: ["Gading Serpong"],
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
  customer_name: "Keira",
  package_size: 5,
  portions_per_delivery: 1,
  address: "Cluster Michelia, Jl. Michelia 10 No 35",
  maps_link: "",
  area: "Gading Serpong",
};

describe("createOrderFromExtraction — the days are required before payment", () => {
  // The field used to be optional, and a missing schedule was filled in from a
  // meal-preference enum: Senin–Jumat, both meals, from tomorrow. galvent said
  // "Jdwal tdk menetap" and asked for one day; five were booked for him.
  it("creates no order and asks which days when the schedule is absent", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(PHONE);
    expect(text).toMatch(/hari apa saja/i);
    // The whole point: no bank details for an order with no days behind it.
    expect(text).not.toMatch(/transfer|BCA|Nominal/i);
    expect(touched).not.toContain("orders");
    expect(touched).not.toContain("daily_deliveries");
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: "assistant" }),
    );
    expect(updateMessageReceipt).toHaveBeenCalled();
  });

  // An empty array is a real answer, not a missing one: it sells the quota with
  // no dates attached, which is how most of the book buys.
  it("creates the order when the customer books day by day", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [],
    });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /hari apa saja/i.test(text),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });

  it("creates the order when the days are named", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      delivery_schedule: [
        { date: "2026-09-01", meal_type: "lunch", portions: 1 },
        { date: "2026-09-02", meal_type: "lunch", portions: 1 },
      ],
    });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /hari apa saja/i.test(text),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });

  // The payment-proof path is a customer who has already transferred. Blocking
  // there would throw away the order behind real money.
  it("still creates the order when we are not the ones asking for money", async () => {
    const touched = mockDb();

    await createOrderFromExtraction(
      CUSTOMER_ID,
      PHONE,
      { ...BASE },
      { sendPaymentInfo: false },
    );

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(touched).toContain("orders");
  });
});
