import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/replay-latest/route";
import { processSavedCustomerMessage } from "@/app/api/webhook/whatsapp/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/app/api/webhook/whatsapp/route", () => ({
  processSavedCustomerMessage: jest.fn().mockResolvedValue(undefined),
}));

function makeChain(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "eq",
    "neq",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "in",
    "limit",
    "order",
    "is",
  ];
  for (const method of methods) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, ReturnType<typeof makeChain>> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) {
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    }
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/replay-latest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: "u1", email: "admin@example.com" } },
      }),
    },
  });
});

describe("POST /api/inbox/replay-latest", () => {
  test("replays the latest saved user message when thread is unblocked", async () => {
    const db = makeDbMock({
      customers: {
        data: {
          id: "cust-1",
          name: "Budi",
          phone_number: "+6281234567890",
          notes: "known customer",
        },
        error: null,
      },
      customer_flags: {
        data: {
          escalated_to_human: false,
          pending_bot_response: false,
          is_blacklisted: false,
        },
        error: null,
      },
      customer_state: {
        data: { state: "ordering", menu_shown: true },
        error: null,
      },
      conversations: {
        data: {
          role: "user",
          content: "saya jadi ambil 1 minggu",
          message_id: "wamid.1",
          message_type: "text",
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ customer_id: "cust-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.replayed).toBe(true);
    expect(processSavedCustomerMessage).toHaveBeenCalledWith({
      customerId: "cust-1",
      customerName: "Budi",
      customerNotes: "known customer",
      phone: "+6281234567890",
      stateRow: { state: "ordering", menu_shown: true },
      text: "saya jadi ambil 1 minggu",
      messageId: null,
    });
  });

  test("returns no-op when latest message is already from assistant", async () => {
    const db = makeDbMock({
      customers: {
        data: {
          id: "cust-1",
          name: "Budi",
          phone_number: "+6281234567890",
          notes: null,
        },
        error: null,
      },
      customer_flags: {
        data: {
          escalated_to_human: false,
          pending_bot_response: false,
          is_blacklisted: false,
        },
        error: null,
      },
      customer_state: {
        data: { state: "ordering", menu_shown: true },
        error: null,
      },
      conversations: {
        data: {
          role: "assistant",
          content: "silakan isi form ya kak",
          message_id: "wamid.2",
          message_type: "text",
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(postRequest({ customer_id: "cust-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.replayed).toBe(false);
    expect(json.reason).toBe("latest_not_user");
    expect(processSavedCustomerMessage).not.toHaveBeenCalled();
  });
});
