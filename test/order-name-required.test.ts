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
const PHONE = "+6287895957020";

/**
 * Records every table touched so a test can assert nothing was written.
 *
 * Permissive on purpose: past the gate, `createOrderFromExtraction` walks a
 * long path (pricing tiers, holidays, delivery rows). These tests only care
 * whether the gate fired, so every builder method keeps chaining and every
 * terminal resolves to something shaped well enough to get through.
 */
function mockDb(customerName: string | null) {
  const touched: string[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000ff",
    name: customerName,
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
    // Awaiting the builder itself (a list query) yields rows. PostgREST's
    // builder is genuinely thenable, so the stub has to be too.
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
  package_size: 5,
  portions_per_delivery: 1,
  address: "Cluster Michelia, Jl. Michelia 10 No 35",
  maps_link: "",
  area: "Gading Serpong",
  // The days are required too, and `[]` is the answer for a customer who books
  // day by day — see order-schedule-required.test.ts. Present so these tests
  // exercise the name gate and not the one after it.
  delivery_schedule: [],
};

describe("createOrderFromExtraction — a name is required before payment", () => {
  // +6287895957020 paid Rp 145.000 on 2026-08-26 and reached the kitchen sheet
  // as "—". The name was not recoverable from the chat or the transfer receipt.
  it("creates no order and asks for the name when there is none", async () => {
    const touched = mockDb(null);

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      customer_name: "",
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(PHONE);
    expect(text).toContain("nama kakak");
    // The whole point: no bank details reach a customer we cannot name.
    expect(text).not.toMatch(/transfer|BCA|Nominal/i);
    expect(touched).not.toContain("orders");
    expect(touched).not.toContain("daily_deliveries");
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: "assistant" }),
    );
    expect(updateMessageReceipt).toHaveBeenCalled();
  });

  it.each([
    "Kak",
    "kakak",
    "Customer",
    "unknown",
    "-",
  ])("treats the placeholder %p as no name at all", async (placeholder) => {
    const touched = mockDb(null);

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      customer_name: placeholder,
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect((sendTextMessage as jest.Mock).mock.calls[0][1]).toContain(
      "nama kakak",
    );
    expect(touched).not.toContain("orders");
  });

  // The payment-proof path is a customer who has already transferred. Blocking
  // there would throw away the order behind real money.
  it("still creates the order when we are not the ones asking for money", async () => {
    const touched = mockDb(null);

    await createOrderFromExtraction(
      CUSTOMER_ID,
      PHONE,
      { ...BASE, customer_name: "" },
      { sendPaymentInfo: false },
    );

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(touched).toContain("orders");
  });

  it("proceeds when the customer already has a name on record", async () => {
    const touched = mockDb("Keira");

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      customer_name: "",
    });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => text.includes("nama kakak"),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });

  it("proceeds when the model supplies a real name for a blank record", async () => {
    const touched = mockDb(null);

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      customer_name: "Kurniadi Tan",
    });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => text.includes("nama kakak"),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });
});
