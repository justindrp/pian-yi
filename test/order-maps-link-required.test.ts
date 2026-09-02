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
const PHONE = "+6281299221430";

/** Same permissive stub as order-schedule-required: only the gate is tested. */
function mockDb(linkOnFile: string | null) {
  const touched: string[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000ff",
    name: "Keira",
    portions: 5,
    price_per_portion: 29000,
    delivery_areas: ["Gading Serpong"],
    google_maps_link: linkOnFile,
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
  customer_name: "Keira",
  package_size: 5,
  portions_per_delivery: 1,
  address: "Cluster Michelia, Jl. Michelia 10 No 35",
  maps_link: "",
  area: "Gading Serpong",
  delivery_schedule: [],
};

describe("createOrderFromExtraction — the maps link is required before payment", () => {
  // 266 of 416 customers had no link on 2026-09-01, and the bot was telling
  // them it did not matter: +6281299221430 was answered "nggak apa apa kak —
  // alamat tulisannya yang penting" on 2026-09-02.
  it("creates no order and asks for the link when there is none anywhere", async () => {
    const touched = mockDb(null);

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(PHONE);
    expect(text).toMatch(/link Google Maps/i);
    // The gesture is Google Maps' own share, not WhatsApp's location button.
    expect(text).toMatch(/Salin link/i);
    // The whole point: creating the order is what sends the bank details.
    expect(text).not.toMatch(/transfer|BCA|Nominal/i);
    expect(touched).not.toContain("orders");
    expect(touched).not.toContain("daily_deliveries");
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: "assistant" }),
    );
    expect(updateMessageReceipt).toHaveBeenCalled();
  });

  it("creates the order when the link arrives in the call", async () => {
    const touched = mockDb(null);

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      maps_link: "https://maps.app.goo.gl/aBcD1234",
    });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /link Google Maps/i.test(text),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });

  it("creates the order when the customer already has a link on file", async () => {
    const touched = mockDb("https://maps.app.goo.gl/onFile99");

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /link Google Maps/i.test(text),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });

  // A pin in the right kampung still beats prose, so it passes the gate. The
  // prompt keeps asking for a dragged-and-copied link; the order is not held.
  it("accepts a shared WhatsApp location rather than holding the order", async () => {
    const touched = mockDb("https://www.google.com/maps?q=-6.2417,106.6339");

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    const asked = (sendTextMessage as jest.Mock).mock.calls.some(
      ([, text]: [string, string]) => /link Google Maps/i.test(text),
    );
    expect(asked).toBe(false);
    expect(touched).toContain("orders");
  });

  // The payment-proof path is a customer who has already transferred.
  it("still creates the order when we are not the ones asking for money", async () => {
    const touched = mockDb(null);

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
