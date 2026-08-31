import { saveMessage } from "@/lib/claude/conversation";
import {
  createOrderFromExtraction,
  type ExtractedOrderInput,
} from "@/lib/claude/extract-order";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/claude/classify-address", () => ({
  classifyAddress: jest.fn().mockResolvedValue("house"),
}));
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn((key: string) =>
    Promise.resolve(
      key === "bank_account_number"
        ? "4971805760"
        : key === "bank_name"
          ? "BCA"
          : key === "bank_account_name"
            ? "Daniel"
            : "X",
    ),
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

const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";
const PHONE = "+6281234567890";
const ORDER_ID = "0d000000-0000-4000-8000-000000000001";
const ORDER_CREATED = "2026-08-29T00:00:00.000Z";

/** Every write the run made, as `${table}.${insert|update|upsert|delete}`. */
let writes: string[] = [];

/**
 * Enough of the PostgREST builder to walk `createOrderFromExtraction`, with
 * three knobs: whether an open `pending_payment` order already exists, when it
 * was created, and whether a payment message for it is already on record in
 * `conversations`.
 */
function mockDb(opts: {
  openOrder: boolean;
  paymentOnRecord: boolean | (() => boolean);
  orderCreatedAt?: string;
}) {
  writes = [];
  const orderCreatedAt = opts.orderCreatedAt ?? ORDER_CREATED;
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const greaterThan: Record<string, unknown> = {};
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
    // Real: a `.gt()` narrows the result. The age cap on the open-order lookup
    // was invisible for as long as this was a no-op like the rest of them.
    chain.gt = (col: string, value: unknown) => {
      greaterThan[col] = value;
      return chain;
    };
    for (const method of ["insert", "update", "upsert", "delete"]) {
      chain[method] = () => {
        op = method;
        writes.push(`${table}.${method}`);
        return chain;
      };
    }
    const result = () => {
      if (table === "orders" && op === "select") {
        // The open-order lookup filters on status; anything else asking about
        // orders is not what these tests are about.
        if (filters.status !== "pending_payment" || !opts.openOrder) return null;
        const floor = greaterThan.created_at;
        if (typeof floor === "string" && orderCreatedAt <= floor) return null;
        return { id: ORDER_ID, created_at: orderCreatedAt };
      }
      if (table === "orders") return { id: ORDER_ID };
      if (table === "conversations" && filters.role === "assistant") {
        const onRecord =
          typeof opts.paymentOnRecord === "function"
            ? opts.paymentOnRecord()
            : opts.paymentOnRecord;
        return onRecord ? { id: "conv-old" } : null;
      }
      if (table === "customers" && op === "select") {
        return { id: CUSTOMER_ID, name: "Rian" };
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
      resolve({ data: [], error: null });
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
}

beforeEach(() => {
  jest.clearAllMocks();
  (sendTextMessage as jest.Mock).mockResolvedValue("wamid.TEST");
});

const INPUT: ExtractedOrderInput = {
  customer_name: "Rian",
  package_size: 5,
  address: "Cluster Allogio Timur 3 No.32",
  area: "Gading Serpong",
  portions_per_delivery: 1,
  maps_link: "",
  delivery_schedule: [],
};

function paymentMessages(): string[] {
  return (sendTextMessage as jest.Mock).mock.calls
    .map(([, text]: [string, string]) => text)
    .filter((t) => t.includes("4971805760"));
}

describe("the bank details are asked for once per purchase", () => {
  // The model re-calls extract_order whenever it restates the summary. The
  // amend stops that becoming a second order; this stops it becoming a second
  // bill. Rian's demo run on 2026-08-29 got the whole transfer block twice.
  test("an amend does not repeat a payment message already on record", async () => {
    mockDb({ openOrder: true, paymentOnRecord: true });

    const result = await createOrderFromExtraction(CUSTOMER_ID, PHONE, INPUT);

    expect(paymentMessages()).toHaveLength(0);
    expect(result.sendPayment).toBeNull();
    // And nothing was written to the thread either — the inbox must not show a
    // message the customer never got.
    expect(saveMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("4971805760"),
      }),
    );
  });

  // The order exists but the ask never reached the customer: the process died
  // between the reply and the send, or the order came from a payment proof. The
  // next turn has to be able to recover it, or they are waiting on a transfer
  // they were never asked to make.
  test("an amend still sends when no payment message is on record", async () => {
    mockDb({ openOrder: true, paymentOnRecord: false });

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, INPUT);

    expect(paymentMessages()).toHaveLength(1);
  });

  // The lookup used to carry a 24-hour age cap, which excluded exactly the
  // orders most likely to need amending: the ones the bot has failed to close.
  // Cindi's 12-porsi order sat unpaid from 2026-08-21 because six turns said
  // "tak siapkan pesanannya" and called no tool; her 2026-08-31 downgrade to 6
  // porsi found nothing and inserted a second order. One payment proof flipped
  // both to payment_proof_received and she held a bill for 18 porsi against a
  // Rp 174.000 transfer.
  test("an open order older than a day is still amended, not duplicated", async () => {
    mockDb({
      openOrder: true,
      paymentOnRecord: true,
      orderCreatedAt: "2026-08-21T12:18:00.000Z",
    });

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, INPUT);

    expect(writes).toContain("orders.update");
    expect(writes).not.toContain("orders.insert");
  });

  test("a first order sends the payment message", async () => {
    mockDb({ openOrder: false, paymentOnRecord: false });

    await createOrderFromExtraction(CUSTOMER_ID, PHONE, INPUT);

    expect(paymentMessages()).toHaveLength(1);
  });

  // Under deferPaymentMessage nothing goes out from here: the webhook sends it
  // after its own reply, so the bank details land after the sentence that
  // introduces them.
  test("deferPaymentMessage hands the send back instead of doing it", async () => {
    mockDb({ openOrder: false, paymentOnRecord: false });

    const { sendPayment } = await createOrderFromExtraction(
      CUSTOMER_ID,
      PHONE,
      INPUT,
      { deferPaymentMessage: true },
    );

    expect(paymentMessages()).toHaveLength(0);
    expect(sendPayment).toEqual(expect.any(Function));

    await sendPayment?.();
    expect(paymentMessages()).toHaveLength(1);
  });

  // The first check runs while the tool is still executing; under
  // deferPaymentMessage the send then waits for the model's reply and its
  // typing delay. Two turns out of one burst both looked, both saw nothing,
  // and both deferred — Sharleen was asked to transfer Rp 1.690.000 twice on
  // 2026-08-31, twenty-one seconds apart. The deferred send looks again.
  test("a payment message that lands while the send is deferred cancels it", async () => {
    let looks = 0;
    mockDb({ openOrder: true, paymentOnRecord: () => ++looks > 1 });

    const { sendPayment } = await createOrderFromExtraction(
      CUSTOMER_ID,
      PHONE,
      INPUT,
      { deferPaymentMessage: true },
    );
    expect(sendPayment).toEqual(expect.any(Function));

    await sendPayment?.();

    expect(paymentMessages()).toHaveLength(0);
    expect(saveMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("4971805760"),
      }),
    );
  });
});
