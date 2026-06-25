import { processWebhookAsync } from "@/app/api/webhook/whatsapp/route";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { getAnthropicClient } from "@/lib/claude/client";
import { loadHistory, saveMessage } from "@/lib/claude/conversation";
import {
  checkRateLimit,
  detectInjection,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  updateTokenCount,
} from "@/lib/claude/safety";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendTextMessage,
  sendTypingIndicator,
} from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/cache/settings");
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "claude-sonnet-4-6",
}));
jest.mock("@/lib/claude/safety");
jest.mock("@/lib/claude/conversation");
jest.mock("@/lib/claude/prompts/system", () => ({
  buildSystemPrompt: jest.fn().mockResolvedValue("You are helpful."),
}));
jest.mock("@/lib/claude/prompts/classifier", () => ({
  classifyIntent: jest.fn().mockResolvedValue("other"),
}));
jest.mock("@/lib/claude/classify-address", () => ({
  classifyAddress: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/claude/photo-matcher", () => ({
  matchDeliveryPhoto: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");
jest.mock("@/lib/utils/delay", () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  calcTypingDelay: jest.fn().mockReturnValue(0),
}));

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "upsert", "update", "delete",
    "eq", "neq", "or", "not", "lt", "gt", "gte", "lte", "in",
    "limit", "order", "is", "ilike",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
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

function makeDefaultDb(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  return makeDbMock({
    processed_messages: { data: null, error: null },
    subcontractors: { data: null, error: null },
    customers: { data: { id: "cust-1", name: "Test Customer", first_message: null }, error: null },
    customer_rate_limits: { data: null, error: null },
    customer_flags: {
      data: {
        is_blacklisted: false,
        escalated_to_human: false,
        pending_bot_response: false,
        pending_bot_question: null,
      },
      error: null,
    },
    customer_state: { data: { state: "idle", menu_shown: true }, error: null },
    orders: { data: null, error: null },
    conversation_logs: { data: null, error: null },
    ...overrides,
  });
}

function makePayload(text = "Halo", from = "628111222333") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "test_entry_id",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "6281234567890",
                phone_number_id: "test-phone-id",
              },
              messages: [
                {
                  id: `msg_${Date.now()}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
              contacts: [{ profile: { name: "Test Customer" }, wa_id: from }],
            },
            field: "messages",
          },
        ],
      },
    ],
  // biome-ignore lint/suspicious/noExplicitAny: test payload
  } as any;
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  (createAdminClient as jest.Mock).mockReturnValue(makeDefaultDb());

  (getSetting as jest.Mock).mockResolvedValue("true");
  (getTemplate as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(`[${key}]`),
  );

  (checkRateLimit as jest.Mock).mockResolvedValue({ allowed: true });
  (isCircuitOpen as jest.Mock).mockReturnValue(false);
  (detectInjection as jest.Mock).mockReturnValue(false);
  (recordSuccess as jest.Mock).mockReturnValue(undefined);
  (recordFailure as jest.Mock).mockResolvedValue(undefined);
  (updateTokenCount as jest.Mock).mockResolvedValue(undefined);
  (loadHistory as jest.Mock).mockResolvedValue([]);
  (saveMessage as jest.Mock).mockResolvedValue(undefined);
  (sendTextMessage as jest.Mock).mockResolvedValue(undefined);
  (sendTypingIndicator as jest.Mock).mockResolvedValue(undefined);
  (sendPushToAllAdmins as jest.Mock).mockResolvedValue(undefined);

  (getAnthropicClient as jest.Mock).mockReturnValue({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: "text", text: "Halo kak!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20 },
      }),
    },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processWebhookAsync", () => {
  test("T1 — idempotency: duplicate message_id is ignored", async () => {
    const db = makeDefaultDb({
      processed_messages: { data: { message_id: "already_seen" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload());

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T2 — kill switch off: sends chatbot_unavailable and skips Claude", async () => {
    (getSetting as jest.Mock).mockResolvedValue("false");

    await processWebhookAsync(makePayload());

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "[chatbot_unavailable]",
    );
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T3 — blacklisted customer: no reply sent", async () => {
    const db = makeDefaultDb({
      customer_flags: {
        data: {
          is_blacklisted: true,
          escalated_to_human: false,
          pending_bot_response: false,
          pending_bot_question: null,
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload());

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T4 — escalated to human: notifies admins and skips Claude", async () => {
    const db = makeDefaultDb({
      customer_flags: {
        data: {
          is_blacklisted: false,
          escalated_to_human: true,
          pending_bot_response: false,
          pending_bot_question: null,
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Tolong bantu saya"));

    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      "New message from escalated customer",
      expect.any(String),
      "/inbox",
      "medium",
    );
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T5 — rate limit exceeded: sends rate_limit_exceeded template", async () => {
    (checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: false,
      reason: "daily_limit",
    });

    await processWebhookAsync(makePayload());

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "[rate_limit_exceeded]",
    );
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T6 — circuit breaker open: sends chatbot_unavailable after admin push", async () => {
    (isCircuitOpen as jest.Mock).mockReturnValue(true);

    await processWebhookAsync(makePayload());

    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      expect.stringContaining("New message from"),
      expect.any(String),
      "/inbox",
      "low",
    );
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "[chatbot_unavailable]",
    );
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T7 — 529 overload retries once and succeeds", async () => {
    jest.useFakeTimers();

    const createFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("529 overloaded_error"))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Halo kak!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20 },
      });

    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create: createFn },
    });

    const promise = processWebhookAsync(makePayload("Mau pesan nasi"));
    await jest.runAllTimersAsync();
    await promise;

    jest.useRealTimers();

    expect(createFn).toHaveBeenCalledTimes(2);
    expect(recordSuccess).toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  test("T8 — non-retryable Claude error triggers push and unavailable reply", async () => {
    const createFn = jest.fn().mockRejectedValue(new Error("401 Unauthorized"));
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create: createFn },
    });

    await processWebhookAsync(makePayload("Mau pesan"));

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalled();
    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      "Claude API error",
      expect.any(String),
      expect.any(String),
      "high",
    );
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "[chatbot_unavailable]",
    );
  });

  test("T9 — saves WhatsApp display name when customer.name is null", async () => {
    const db = makeDefaultDb({
      customers: { data: { id: "cust-1", name: null, first_message: "Halo" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Halo"));

    expect(db.chains.customers.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Test Customer" }),
    );
  });

  test("T10 — does not overwrite existing customer name with WhatsApp display name", async () => {
    const db = makeDefaultDb({
      customers: { data: { id: "cust-1", name: "Budi Santoso", first_message: "Halo" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Halo"));

    expect(db.chains.customers.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) }),
    );
  });
});
