import { getExcludedNeighborhoods } from "@/lib/cache/settings";
import { saveMessage } from "@/lib/claude/conversation";
import { createOrderFromExtraction } from "@/lib/claude/extract-order";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/claude/classify-address", () => ({
  classifyAddress: jest.fn().mockResolvedValue("apartment"),
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

const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000002";
const PHONE = "+6281200000002";

/** Same permissive stub as order-maps-link-required: only the gate is tested. */
function mockDb() {
  const touched: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const row = {
    id: "00000000-0000-4000-8000-0000000000fe",
    name: "Naya",
    portions: 5,
    price_per_portion: 29000,
    delivery_areas: ["Alam Sutera"],
    google_maps_link: "https://maps.app.goo.gl/onFile99",
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
      "upsert",
      "delete",
    ]) {
      chain[method] = () => chain;
    }
    chain.update = (values: Record<string, unknown>) => {
      updates.push(values);
      return chain;
    };
    chain.maybeSingle = async () => ({ data: row, error: null });
    chain.single = async () => ({ data: row, error: null });
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [row], error: null });
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return { touched, updates };
}

beforeEach(() => {
  jest.clearAllMocks();
  (sendTextMessage as jest.Mock).mockResolvedValue("wamid.TEST");
  (getExcludedNeighborhoods as jest.Mock).mockResolvedValue([
    { area: "Alam Sutera", name: "Synergy Building" },
  ]);
});

const BASE = {
  customer_name: "Naya",
  package_size: 5,
  portions_per_delivery: 1,
  address: "Synergy Building lantai 12, Alam Sutera",
  maps_link: "https://maps.app.goo.gl/onFile99",
  area: "Alam Sutera",
  delivery_schedule: [],
};

describe("createOrderFromExtraction — an excluded place is refused", () => {
  // Deleting the area_neighborhoods row only stopped the bot recognising the
  // name; the nearest-area rule then rounded it into Alam Sutera and sold to it
  // anyway. That is the Taman Tekno failure (2026-08-30) and it would have been
  // Synergy Building's (2026-09-03), which is why the row is flagged, not gone.
  it("creates no order and sends no bank details", async () => {
    const { touched, updates } = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(PHONE);
    expect(text).toContain("Synergy Building");
    expect(text).not.toMatch(/transfer|BCA|Nominal/i);
    expect(touched).not.toContain("orders");
    expect(touched).not.toContain("daily_deliveries");
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: "assistant" }),
    );
    expect(
      updates.some((u) => u.needs_human_review === true),
    ).toBe(true);
  });

  // The refusal is ours, not one kitchen's, so it must not read as "we will
  // find you another dapur" — nobody goes there.
  it("does not promise another kitchen", async () => {
    mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, { ...BASE });

    const [, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(text).not.toMatch(/dapur/i);
  });

  it("matches the exclusion on the sub_area as well as the address", async () => {
    const { touched } = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      address: "Jl. Jalur Sutera Barat No 16",
      sub_area: "Synergy Building",
    });

    expect(touched).not.toContain("orders");
  });

  it("creates the order for an ordinary address in the same area", async () => {
    const { touched } = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, {
      ...BASE,
      address: "Cluster Sutera Onyx No 12, Alam Sutera",
    });

    expect(touched).toContain("orders");
  });

  // That customer has already transferred: the order is created and the flag is
  // what surfaces the problem, same as the kitchen-level refusal below it.
  it("still creates the order on the payment-proof path", async () => {
    const { touched } = mockDb();

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
