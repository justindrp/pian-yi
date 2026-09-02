import { saveMessage } from "@/lib/claude/conversation";
import { createOrderFromExtraction } from "@/lib/claude/extract-order";
import { sendPushToAllAdmins } from "@/lib/push/send";
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
const BUYER_ID = "c0000000-0000-4000-8000-000000000001";
const BUYER_PHONE = "+6285155005162";
const CILA_ID = "c0000000-0000-4000-8000-0000000000c1";
const CILA_PHONE = "+6281234567890";

type Write = { table: string; op: string; payload: unknown };

/**
 * Enough of the PostgREST builder to walk the whole of
 * `createOrderFromExtraction`, recording every write and every filter so a test
 * can ask which customer the order landed on.
 *
 * `customers` lookups answer from `people`, keyed by whatever the query filtered
 * on — that is the part these tests turn on: a lookup by phone must find Cila,
 * and the order must be written against the id it returns.
 */
function mockDb(byPhone: Record<string, { id: string; name: string | null }>) {
  const writes: Write[] = [];
  // Reachable by either key, because the code looks a customer up both ways:
  // the beneficiary by phone, the buyer by id.
  const people: Record<string, { id: string; name: string | null }> = {};
  for (const [phone, person] of Object.entries(byPhone)) {
    people[phone] = person;
    people[person.id] = person;
  }
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let op = "select";
    let payload: unknown = null;
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
        payload = body;
        writes.push({ table, op: method, payload: body });
        return chain;
      };
    }
    const result = () => {
      if (table === "customers" && op === "select") {
        const key = (filters.phone_number ?? filters.id) as string | undefined;
        const person = key ? people[key] : undefined;
        // Everyone here already has a link on file; the maps-link gate is
        // covered in its own suite.
        return person ? { ...person, google_maps_link: "https://maps.app.goo.gl/testlink" } : null;
      }
      if (table === "customers" && op === "insert") {
        const inserted = payload as { phone_number: string; name: string };
        const created = {
          id: "c0000000-0000-4000-8000-0000000000ee",
          name: inserted.name,
        };
        people[inserted.phone_number] = created;
        people[created.id] = created;
        return created;
      }
      if (table === "orders") {
        return { id: "0d000000-0000-4000-8000-000000000001", created_at: NOW };
      }
      // Nothing has been said to this customer yet, so no payment message is on
      // record and the guard against repeating one must not fire.
      if (table === "conversations" && filters.role === "assistant") {
        return null;
      }
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
  customer_name: "Naya",
  package_size: 5,
  portions_per_delivery: 1,
  address: "Kost Cila, Jl. Melati 3",
  maps_link: "",
  area: "Gading Serpong",
  // Required now: an order without the days is refused before anything is
  // written, so every fixture here has to carry them.
  delivery_schedule: [
    { date: "2026-09-01", meal_type: "lunch", portions: 1 },
    { date: "2026-09-02", meal_type: "lunch", portions: 1 },
    { date: "2026-09-03", meal_type: "lunch", portions: 1 },
    { date: "2026-09-04", meal_type: "lunch", portions: 1 },
    { date: "2026-09-05", meal_type: "lunch", portions: 1 },
  ],
};

function orderWrite(writes: Write[]) {
  return writes.find((w) => w.table === "orders") as Write | undefined;
}

describe("a package bought for someone else", () => {
  // 2026-08-24: Naya ordered for herself and for Cila in one conversation, and
  // the second call overwrote the first because the amend keyed on the buyer.
  it("puts the order on the beneficiary, not on the buyer", async () => {
    const writes = mockDb({
      [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" },
      [CILA_PHONE]: { id: CILA_ID, name: "Cila" },
    });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
      beneficiary_phone: "0812-3456-7890",
    });

    const order = orderWrite(writes);
    expect(order).toBeDefined();
    expect(order?.payload).toMatchObject({
      customer_id: CILA_ID,
      paid_by_customer_id: BUYER_ID,
    });
  });

  it("stores the schedule on the beneficiary's order, and writes no rows yet", async () => {
    // Order creation records the days; mark_paid turns them into deliveries.
    // Writing rows here put food on a kitchen sheet for an order nobody had
    // paid for — nothing filters that sheet by order status.
    const writes = mockDb({
      [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" },
      [CILA_PHONE]: { id: CILA_ID, name: "Cila" },
    });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
      beneficiary_phone: CILA_PHONE,
    });

    expect(
      writes.find(
        (w) =>
          w.table === "daily_deliveries" &&
          (w.op === "upsert" || w.op === "insert"),
      ),
    ).toBeUndefined();

    const order = orderWrite(writes);
    const schedule = (
      order?.payload as {
        customer_id: string;
        requested_schedule: { date: string; meal_type: string }[] | null;
      }
    )?.requested_schedule;
    expect((order?.payload as { customer_id: string }).customer_id).toBe(
      CILA_ID,
    );
    expect(schedule?.length).toBeGreaterThan(0);
    expect(schedule?.every((r) => r.meal_type === "lunch")).toBe(true);
  });

  // The guards on the customer update only protect against a blank value, not
  // against a value belonging to the wrong person.
  it("never writes the buyer's address onto an existing beneficiary", async () => {
    const writes = mockDb({
      [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" },
      [CILA_PHONE]: { id: CILA_ID, name: "Cila" },
    });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
      beneficiary_phone: CILA_PHONE,
    });

    const updates = writes.filter(
      (w) => w.table === "customers" && w.op === "update",
    );
    expect(updates).toHaveLength(0);
  });

  it("creates the beneficiary when the number is new to us", async () => {
    const writes = mockDb({ [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" } });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
      beneficiary_phone: "081234567890",
    });

    const created = writes.find(
      (w) => w.table === "customers" && w.op === "insert",
    );
    expect(created?.payload).toMatchObject({
      phone_number: CILA_PHONE,
      name: "Cila",
      address: BASE.address,
    });
  });

  it("tells the buyer which package the transfer is for", async () => {
    mockDb({
      [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" },
      [CILA_PHONE]: { id: CILA_ID, name: "Cila" },
    });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
      beneficiary_phone: CILA_PHONE,
    });

    const payment = (sendTextMessage as jest.Mock).mock.calls.find(
      ([, text]: [string, string]) => text.includes("transfer"),
    );
    expect(payment?.[0]).toBe(BUYER_PHONE);
    expect(payment?.[1]).toContain("atas nama Cila");
    // Greeted as the buyer, not as their friend.
    expect(payment?.[1]).toContain("kak Naya");
    // Everything is said to the buyer's thread; Cila is never messaged.
    expect(saveMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CILA_ID }),
    );
  });

  it("writes nothing and asks when the number is missing", async () => {
    const writes = mockDb({ [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" } });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
    });

    expect(writes.filter((w) => w.table === "orders")).toHaveLength(0);
    expect(writes.filter((w) => w.table === "customers")).toHaveLength(0);
    const [to, text] = (sendTextMessage as jest.Mock).mock.calls[0];
    expect(to).toBe(BUYER_PHONE);
    expect(text).toContain("nomor WhatsApp");
    expect(text).not.toMatch(/transfer|Nominal/i);
    expect(sendPushToAllAdmins).toHaveBeenCalled();
  });

  it("writes nothing and asks when the number cannot be read", async () => {
    const writes = mockDb({ [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" } });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Cila",
      beneficiary_phone: "nanti saya tanya dulu",
    });

    expect(writes.filter((w) => w.table === "orders")).toHaveLength(0);
    expect((sendTextMessage as jest.Mock).mock.calls[0][1]).toContain(
      "nomor WhatsApp",
    );
  });

  // Money that has already moved outranks a missing field: blocking here would
  // throw away the order behind a real transfer.
  it("falls back to an ordinary order on the payment-proof path", async () => {
    const writes = mockDb({ [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" } });

    await createOrderFromExtraction(
      BUYER_ID,
      BUYER_PHONE,
      { ...BASE, beneficiary_name: "Cila" },
      { sendPaymentInfo: false },
    );

    expect(orderWrite(writes)?.payload).toMatchObject({
      customer_id: BUYER_ID,
      paid_by_customer_id: null,
    });
  });

  it("treats the buyer's own number as an ordinary order", async () => {
    const writes = mockDb({ [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" } });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, {
      ...BASE,
      beneficiary_name: "Naya",
      beneficiary_phone: "085155005162",
    });

    expect(orderWrite(writes)?.payload).toMatchObject({
      customer_id: BUYER_ID,
      paid_by_customer_id: null,
    });
  });

  it("leaves an ordinary order untouched", async () => {
    const writes = mockDb({ [BUYER_PHONE]: { id: BUYER_ID, name: "Naya" } });

    await createOrderFromExtraction(BUYER_ID, BUYER_PHONE, BASE);

    expect(orderWrite(writes)?.payload).toMatchObject({
      customer_id: BUYER_ID,
      paid_by_customer_id: null,
    });
    expect(
      writes.filter((w) => w.table === "customers" && w.op === "update"),
    ).toHaveLength(1);
  });
});
