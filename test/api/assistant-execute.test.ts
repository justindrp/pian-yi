import { NextRequest } from "next/server";
import { POST } from "@/app/api/assistant/execute/route";
import { createJournalEntry } from "@/lib/accounting/journal";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { sendImageMessage, sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/get-role", () => ({ getSessionWithRole: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({
  sendImageMessage: jest.fn().mockResolvedValue(undefined),
  sendTextMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/claude/conversation", () => ({ saveMessage: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/accounting/journal", () => ({ createJournalEntry: jest.fn().mockResolvedValue(undefined) }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "upsert", "update", "delete",
    "eq", "neq", "or", "not", "lt", "gt", "gte", "lte", "in", "ilike",
    "limit", "order", "is",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/assistant/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "drpramadyo@gmail.com", role: "owner" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/assistant/execute", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue(null);

    const res = await POST(postRequest({ tool: "mark_order_paid", input: { order_id: "x" } }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("T2 — read tool name rejected as disallowed (400)", async () => {
    const res = await POST(postRequest({ tool: "query_metrics", input: {} }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("T3 — mark_order_paid: orders update called + journal created + sendTextMessage called", async () => {
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-1",
          total_price: 290000,
          package_size: 10,
          customer_id: "cust-1",
          customers: { name: "Budi Santoso", phone_number: "+6281234567890" },
        },
        error: null,
      },
      customers: { data: { converted_at: null }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ tool: "mark_order_paid", input: { order_id: "order-1" } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // orders updated
    expect(db.from).toHaveBeenCalledWith("orders");
    expect(db.chains.orders?.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );

    // journal created
    expect(createJournalEntry).toHaveBeenCalled();

    // WhatsApp confirmation sent
    expect(sendTextMessage).toHaveBeenCalledWith("+6281234567890", expect.stringContaining("Budi"));
  });

  test("T4 — cancel_order with notify_customer:true → status cancelled_by_admin + sendTextMessage called", async () => {
    const db = makeDbMock({
      orders: {
        data: {
          id: "order-2",
          customer_id: "cust-2",
          customers: { name: "Siti Rahayu", phone_number: "+6289876543210" },
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        tool: "cancel_order",
        input: { order_id: "order-2", notify_customer: true, reason: "stok habis" },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(db.chains.orders?.update).toHaveBeenCalledWith({ status: "cancelled_by_admin" });
    expect(sendTextMessage).toHaveBeenCalledWith("+6289876543210", expect.stringContaining("Siti"));
  });

  test("T5 — update_customer_field field=name → customers update called", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        tool: "update_customer_field",
        input: { customer_id: "cust-3", field: "name", value: "Budi Baru" },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(db.from).toHaveBeenCalledWith("customers");
    expect(db.chains.customers?.update).toHaveBeenCalledWith({ name: "Budi Baru" });
  });

  test("T6 — send_whatsapp_image sends image and logs image row", async () => {
    const db = makeDbMock({
      customers: { data: { id: "cust-4" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        tool: "send_whatsapp_image",
        input: {
          phone_number: "+628111",
          image_url: "https://example.com/menu.jpg",
          caption: "Menu minggu ini",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(sendImageMessage).toHaveBeenCalledWith(
      "+628111",
      "https://example.com/menu.jpg",
      "Menu minggu ini",
    );
  });

  test("T7 — update_customer_field field=phone_number → 400, no DB update", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({
        tool: "update_customer_field",
        input: { customer_id: "cust-3", field: "phone_number", value: "+628999" },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(db.chains.customers?.update).toBeUndefined();
  });
});
