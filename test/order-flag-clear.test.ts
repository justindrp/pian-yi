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
const PHONE = "+6281232798189";

// `filters` is the live object the chain mutates, so a write recorded here
// still picks up the `.eq()` calls that come after `.update()`.
type Write = {
  table: string;
  op: string;
  payload: unknown;
  filters: Record<string, unknown>;
};

/** Enough of the PostgREST builder to walk `createOrderFromExtraction`. */
function mockDb(): Write[] {
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
        writes.push({ table, op: method, payload: body, filters });
        return chain;
      };
    }
    const result = () => {
      if (table === "customers" && op === "select") {
        return { id: CUSTOMER_ID, phone_number: PHONE, name: "Carolin" };
      }
      if (table === "orders") {
        return { id: "0d000000-0000-4000-8000-000000000001", created_at: NOW };
      }
      // No payment message on record, so the repeat guard must not fire.
      if (table === "conversations" && filters.role === "assistant") return null;
      if (table === "pricing_tiers") {
        return { portions: 5, price_per_portion: 29000 };
      }
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
  customer_name: "Carolin",
  package_size: 5,
  portions_per_delivery: 5,
  address: "Sky House BSD, Kensington Tower, Unit KS-GN",
  maps_link: "https://www.google.com/maps?q=-6.3033963,106.6495506",
  area: "BSD Baru",
  delivery_schedule: [
    { date: "2026-09-01", meal_type: "lunch", portions: 5 },
  ],
};

// 2026-08-29: Carolin was flagged at 05:20 with "Kemungkinan order belum
// tercatat: 5 porsi", ordered at 05:49, and was still flagged at 05:52 — the
// warning had come true and nothing cleared it. Ten customers had piled up
// that way, which is how the next real alert gets ignored.
describe("an order that lands answers the flag that warned it might not", () => {
  it("clears needs_human_review for the customer who was in the conversation", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, BASE);

    const clear = writes.find(
      (w) => w.table === "customer_flags" && w.op === "update",
    );
    expect(clear).toBeDefined();
    expect(clear?.payload).toMatchObject({
      needs_human_review: false,
      escalation_reason: null,
    });
    expect(clear?.filters).toMatchObject({
      customer_id: CUSTOMER_ID,
      needs_human_review: true,
    });
  });

  it("leaves the takeover flag alone", async () => {
    const writes = mockDb();

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, BASE);

    for (const w of writes.filter((x) => x.table === "customer_flags")) {
      expect(w.payload).not.toHaveProperty("escalated_to_human");
    }
  });
});
