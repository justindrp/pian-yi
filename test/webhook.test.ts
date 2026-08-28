import { processWebhookAsync } from "@/app/api/webhook/whatsapp/route";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { getAnthropicClient } from "@/lib/claude/client";
import { loadHistory, saveMessage } from "@/lib/claude/conversation";
import { classifyIntent } from "@/lib/claude/prompts/classifier";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";
import {
  checkRateLimit,
  detectInjection,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  updateTokenCount,
} from "@/lib/claude/safety";
import { validateReply } from "@/lib/claude/validate-reply";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage, sendTypingIndicator } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/cache/settings");
jest.mock("@/lib/claude/client", () => ({
  ...jest.requireActual("@/lib/claude/client"),
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
jest.mock("@/lib/claude/validate-reply", () => ({
  validateReply: jest
    .fn()
    .mockResolvedValue({ valid: true, unsupportedClaims: [] }),
}));
// Sentiment analysis is fire-and-forget and calls Haiku through the same
// Anthropic client these tests mock, so leaving it real makes it steal
// responses from the createFn queue and inflate every call count.
jest.mock("@/lib/claude/analyze-customer-message", () => ({
  analyzeCustomerMessage: jest.fn().mockResolvedValue(undefined),
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
    "ilike",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table])
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function makeDefaultDb(
  overrides: Record<string, { data: unknown; error: unknown }> = {},
) {
  return makeDbMock({
    processed_messages: { data: null, error: null },
    subcontractors: { data: null, error: null },
    customers: {
      data: { id: "cust-1", name: "Test Customer", first_message: null },
      error: null,
    },
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

function makeImagePayload(from = "628111222333") {
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
                  id: `img_${Date.now()}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "image",
                  image: { id: "media-1", mime_type: "image/jpeg" },
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
  (validateReply as jest.Mock).mockResolvedValue({
    valid: true,
    unsupportedClaims: [],
  });
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
      "New message — you have this thread",
      expect.any(String),
      "/inbox",
      "high",
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

  test("T9 — does NOT save WhatsApp display name to customer.name", async () => {
    // Name must come from the order form only, never the WhatsApp profile name,
    // so a contact is not "renamed" before they order and pay.
    const db = makeDefaultDb({
      customers: {
        data: { id: "cust-1", name: null, first_message: "Halo" },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Halo"));

    expect(db.chains.customers.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) }),
    );
  });

  test("T10 — does not overwrite existing customer name with WhatsApp display name", async () => {
    const db = makeDefaultDb({
      customers: {
        data: { id: "cust-1", name: "Budi Santoso", first_message: "Halo" },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Halo"));

    expect(db.chains.customers.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) }),
    );
  });

  test("T11 — reply validator passes: sends normally, one Sonnet call", async () => {
    await processWebhookAsync(makePayload("Halo"));

    expect(validateReply).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "Halo kak!",
    );
  });

  test("T12 — reply validator rejects once, regenerated reply passes: sends corrected reply", async () => {
    (validateReply as jest.Mock)
      .mockResolvedValueOnce({
        valid: false,
        unsupportedClaims: ["invented quota"],
      })
      .mockResolvedValueOnce({ valid: true, unsupportedClaims: [] });

    const createFn = jest
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Kuota kakak masih 10 porsi ya" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Aku cek dulu ya kak" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 60, output_tokens: 15 },
      });
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create: createFn },
    });

    await processWebhookAsync(makePayload("Sisa kuota saya berapa?"));

    expect(createFn).toHaveBeenCalledTimes(2);
    expect(validateReply).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "Aku cek dulu ya kak",
    );
  });

  test("T13 — reply validator rejects twice: sends safe fallback and escalates to admin", async () => {
    (validateReply as jest.Mock).mockResolvedValue({
      valid: false,
      unsupportedClaims: ["invented quota"],
    });

    const createFn = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "Kuota kakak masih 10 porsi ya" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create: createFn },
    });

    await processWebhookAsync(makePayload("Sisa kuota saya berapa?"));

    expect(createFn).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      "[reply_validation_fallback]",
    );
    expect(sendPushToAllAdmins).toHaveBeenCalledWith(
      "Reply blocked — possible hallucination",
      expect.any(String),
      "/inbox",
      "high",
    );
  });

  test("T14 — payment proof image is gated by latest order status, not customer_state", async () => {
    const db = makeDefaultDb({
      customer_state: {
        data: { state: "idle", menu_shown: true },
        error: null,
      },
      orders: {
        data: { id: "order-1", status: "pending_payment" },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makeImagePayload());

    expect(db.chains.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_proof_received" }),
    );
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T15 — burst: a message superseded by a newer one draws no reply", async () => {
    const db = makeDefaultDb({
      // Whatever this message's id is, the newest saved inbound is a different
      // one — the customer kept typing while this one was held.
      conversations: { data: { message_id: "wamid.NEWER" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Ini kenapa datengnya sapi ya?"));

    expect(getAnthropicClient).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
  // The kill switch used to return before the customer upsert, so a message
  // that arrived while the bot was off left no customer row, nothing in
  // `conversations` and no record of the template we sent back — while
  // `processed_messages` had already claimed it, making the message
  // unreprocessable and invisible to every admin.
  test("T16 — kill switch off: saves both halves of the exchange and closes the message out", async () => {
    const db = makeDefaultDb();
    (createAdminClient as jest.Mock).mockReturnValue(db);
    (getSetting as jest.Mock).mockResolvedValue("false");

    await processWebhookAsync(makePayload("Halo kak, mau pesan"));

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust-1",
        role: "user",
        content: "Halo kak, mau pesan",
      }),
    );
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust-1",
        role: "assistant",
        content: "[chatbot_unavailable]",
      }),
    );
    expect(sendPushToAllAdmins).toHaveBeenCalled();
    expect(db.chains.processed_messages.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  // Only a unique violation means someone else owns the message. Any other
  // insert failure has to throw: processWebhookAsync resolving normally is
  // what marks the `webhook_events` row processed, and Meta never retries a
  // 200, so swallowing a connection error destroyed the message outright.
  test("T17 — a non-unique-violation error on the idempotency claim throws", async () => {
    const db = makeDefaultDb({
      processed_messages: {
        data: null,
        error: { code: "08006", message: "connection failure" },
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await expect(processWebhookAsync(makePayload())).rejects.toMatchObject({
      code: "08006",
    });

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });

  test("T18 — a unique violation on the idempotency claim returns quietly", async () => {
    const db = makeDefaultDb({
      processed_messages: {
        data: null,
        error: { code: "23505", message: "duplicate key value" },
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await expect(processWebhookAsync(makePayload())).resolves.toBeUndefined();

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });
  // The follow-up call that asks for the text to go with a tool call used to
  // feed the model the literal string "done" for every tool, so a
  // record_daily_order that booked nothing came back as success and the model
  // could answer "sudah tercatat kak" over an empty calendar.
  test("T19 — a tool that wrote nothing is reported to the model as a failure", async () => {
    const db = makeDefaultDb({
      // No active order, so record_daily_order bails before touching the sheet.
      orders: { data: [], error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const create = jest
      .fn()
      // First turn: a tool call with no text alongside it.
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "record_daily_order",
            input: {
              delivery_dates: ["2026-09-01"],
              meal_type: "lunch",
              portions: 1,
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      // Follow-up: the text that should have come with it.
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Maaf kak, belum bisa dicatat." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    (getAnthropicClient as jest.Mock).mockReturnValue({ messages: { create } });

    await processWebhookAsync(makePayload("Besok kirim ya kak"));

    expect(create).toHaveBeenCalledTimes(2);
    const followUp = create.mock.calls[1][0];
    const toolResult = followUp.messages.at(-1).content[0];
    expect(toolResult.tool_use_id).toBe("tool-1");
    expect(toolResult.is_error).toBe(true);
    expect(JSON.parse(toolResult.content)).toEqual(
      expect.objectContaining({ ok: false, error: expect.any(String) }),
    );
    expect(toolResult.content).not.toBe("done");
  });

  // stateRow is read once near the top of processWebhookAsync and handed to
  // processSavedCustomerMessage, which feeds it to buildSystemPrompt. Both
  // writes below used to leave the snapshot stale for the rest of the turn.
  test("T20 — the model is told menuShown:true on the turn the welcome sequence ran", async () => {
    const db = makeDefaultDb({
      customer_state: {
        data: { state: "idle", menu_shown: false },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    await processWebhookAsync(makePayload("Halo"));

    expect(db.chains.customer_state.update).toHaveBeenCalledWith({
      menu_shown: true,
    });
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ menuShown: true }),
    );
  });

  test("T21 — the model is told customerState:ordering on the turn the customer starts ordering", async () => {
    const db = makeDefaultDb({
      customer_state: { data: { state: "new", menu_shown: true }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    (classifyIntent as jest.Mock).mockResolvedValueOnce("ordering");

    await processWebhookAsync(makePayload("Mau pesan 10 porsi kak"));

    expect(db.chains.customer_state.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "ordering" }),
    );
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ customerState: "ordering" }),
    );
  });
});
