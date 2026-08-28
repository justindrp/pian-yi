# Pian Yi WhatsApp Webhook Review

Yes. After reading the actual file, I would **definitely split it**. My earlier recommendation was correct, but “move things into services” was too vague.

The file is **2,747 lines**. More importantly, three functions account for about **69% of the entire file**:

| Function | Lines | Assessment |
|---|---:|---|
| `processWebhookAsync()` | 706 | Far too much responsibility |
| `processSavedCustomerMessage()` | 829 | Biggest architectural problem |
| `handleToolUse()` | 354 | Business-logic monolith |
| `POST()` | 51 | Actually fine |

So the HTTP route itself isn't the problem. **The module behind it has become the entire WhatsApp application.**

## The biggest problems I found

### 1. There is a real potential message-loss bug

At lines **731–744**, you correctly use the insert into `processed_messages` as the atomic idempotency claim:

```ts
const { error: insertError } = await db
  .from("processed_messages")
  .insert({ message_id: message.messageId });

if (insertError) return;
```

The comment assumes:

> insert error = unique violation = another request already processed it.

That's false.

The insert could fail because of:

- database connectivity
- timeout
- schema issue
- permission problem
- Supabase error
- anything else

And you silently return.

That's particularly dangerous because `processWebhookAsync()` then resolves normally. The outer code can mark the raw `webhook_events` row as successfully processed.

You should only swallow an actual PostgreSQL unique violation:

```ts
if (insertError) {
  if (insertError.code === "23505") {
    return;
  }

  throw insertError;
}
```

**Severity: high. Fix this before doing the architectural refactor.**

---

## 2. Your tool-result loop lies to the model

This is the most interesting bug I found.

At lines **1995–2017**, if Claude produces a tool call without accompanying text, you execute the tool and then send the result back to Claude.

The comment says:

> "Run the tool first ... so the follow-up call can report the real result"

Good design.

Except you don't send the real result.

You send:

```ts
content: "done",
```

for **every tool**.

Meanwhile `handleToolUse()` returns:

```ts
Promise<void>
```

And `record_daily_order` has a ton of failure paths:

```text
no valid date
no active order
no draw order
no quota
all dates holidays
nothing to book
DB insert failed
quota insufficient
```

For example, around lines 2498–2512:

```ts
if (custUnbooked <= 0) {
  ...
  return;
}
```

The operation failed.

But the model receives:

```text
done
```

So it can answer:

> "Sudah kak, jadwalnya sudah tercatat."

when absolutely nothing was recorded.

That's exactly the class of failure much of this file is trying to eliminate.

### This should change fundamentally

`handleToolUse()` should return something like:

```ts
type ToolResult =
  | {
      ok: true;
      message: string;
      data?: unknown;
    }
  | {
      ok: false;
      error: string;
    };
```

Then:

```ts
const result = await executeTool(tool);

content: JSON.stringify(result);
```

For example:

```json
{
  "ok": false,
  "error": "Customer only has 2 unbooked portions; requested 6."
}
```

Now the model can tell the customer the truth.

**Severity: high.**

---

## 3. Kill switch currently appears to discard customer messages from the inbox

Look at the order:

```ts
// Kill switch
const chatbotEnabled = await getSetting("chatbot_enabled");

if (chatbotEnabled !== "true") {
  const tmpl = await getTemplate("chatbot_unavailable");
  await sendTextMessage(message.from, tmpl);
  return;
}

// Upsert customer
const { data: customer } = ...
```

That's lines **767–785**.

When the chatbot is disabled:

1. idempotency claims the inbound message;
2. bot sends "chatbot unavailable";
3. function returns;
4. customer isn't upserted;
5. inbound message isn't saved into `conversations`;
6. outbound unavailable message isn't saved either.

That's backwards.

When the AI is disabled, **the human inbox becomes more important, not less important.**

The kill switch should mean:

> don't let AI respond.

It shouldn't mean:

> stop ingesting WhatsApp conversations.

I would persist the customer and inbound message first, then apply the kill switch.

Also, that branch never sets `processed_messages.processed_at`, unlike your normal successful path.

**Severity: high operationally.**

---

## 4. You have stale state inside the same request

This one is subtle.

You load:

```ts
const { data: stateRow } = await db
  .from("customer_state")
  .select("state, menu_shown")
```

Then later:

```ts
if (intent === "ordering" ...) {
  await db
    .from("customer_state")
    .update({ state: "ordering" })
}
```

But you never update the in-memory `stateRow`.

Then you pass the old object into:

```ts
processSavedCustomerMessage({
  ...
  stateRow,
});
```

Inside that function:

```ts
buildSystemPrompt({
  customerState: stateRow?.state ?? "new",
```

So a customer can transition:

```text
new → ordering
```

in the database while Claude is still told:

```text
customerState = "new"
```

for that same message.

### There's an even clearer version

The welcome flow does:

```ts
.update({ menu_shown: true })
```

at lines **1188–1194**.

You then actually send the welcome message, price list, menus, T&C, etc.

But afterward you pass the original:

```ts
stateRow
```

to the model.

So `processSavedCustomerMessage()` can receive:

```ts
menuShown: false
```

immediately after you've just sent the menu.

This is exactly the kind of bug you get when one giant orchestration function mutates state while continuing to carry an old snapshot around.

**Severity: medium/high.**

---

## 5. There's literally dead duplicate work

Lines **1154–1181**:

```ts
const history = await loadHistory(customerId);

const casualProbRaw = await getSetting("casual_mode_probability");
const casualProb = ...
const _casual = Math.random() < casualProb;

const mapsLinkRegex = ...
let detectedMapsLink = ...
```

None of this is subsequently used.

Then `processSavedCustomerMessage()` does all of it again at roughly lines 1545 onward:

```ts
const history = await loadHistory(customerId);

const casualProbRaw = ...
const casual = ...

let detectedMapsLink = ...
```

and this time it actually feeds the values to `buildSystemPrompt()`.

So the live webhook currently:

```text
loadHistory()
getSetting()
Math.random()
scan entire history for Maps link
```

and throws all the results away.

Then does it again.

This should simply be deleted from `processWebhookAsync()`.

This is a good example of why the file has become too difficult to maintain: apparently some logic was moved into `processSavedCustomerMessage()`, but its old version remained behind.

---

## 6. Burst coalescing happens too late

Conceptually your burst strategy is good:

```text
"Ka"
"mau tanya"
"besok bisa?"
        ↓
one AI response
```

But the 15-second wait doesn't happen until line ~1461, inside `processSavedCustomerMessage()`.

Before getting there, every inbound burst message has already gone through things including:

```ts
classifyIntent(text)
saveMessage(...)
tryLearnCustomerContext(...)
sendPushToAllAdmins(...)
```

So four rapid customer messages can still generate:

- four classifier calls
- multiple context-learning attempts
- four admin pushes
- four full passes through much of `processWebhookAsync`

Only the big conversational-model reply is coalesced.

The comment says this:

> "cuts a burst's model spend to one call."

Not quite.

It cuts **the main response calls** to one. Earlier model-powered preprocessing can still happen per message.

I would coalesce immediately **after reliably persisting the inbound message**, before expensive analysis.

Something closer to:

```text
receive
↓
persist inbound
↓
burst wait
↓
superseded?
├─ yes → stop
└─ no
   ↓
classify / learn / Sonnet / tools
```

---

## 7. `processSavedCustomerMessage()` is trying to serve three different products

Its arguments tell the story:

```ts
draft?: boolean;
coalesceBurst?: boolean;
messageId?: string | null;
```

It is simultaneously:

1. the production live-chat pipeline;
2. replay processing;
3. admin draft generation.

Those modes have fundamentally different side-effect requirements.

And the comments explicitly promise:

> "in draft mode the only thing that happens is the model call."

But that isn't actually true.

For example, injection detection in draft mode still does:

```ts
await db
  .from("customer_flags")
  .update({ is_suspicious: true })
```

lines **1510–1520**.

And a Claude API failure still triggers:

```ts
sendPushToAllAdmins("Claude API error", ...)
```

even in draft mode.

`recordSuccess()` / `recordFailure()` also alter global circuit-breaker state.

So the function's modes are already leaking into one another.

I wouldn't add more `if (!draft)` checks.

I'd separate:

```ts
generateReply()
```

from:

```ts
processLiveReply()
```

The first builds context and calls the model.

The second owns side effects.

---

## 8. `handleToolUse()` shouldn't contain `record_daily_order`

`handleToolUse()` is 354 lines.

But most of that isn't tool dispatching.

This:

```ts
if (tool.name === "record_daily_order") {
   ...
}
```

contains approximately **200+ lines of actual delivery domain logic**:

- date normalization
- finding active orders
- calculating unbooked quota
- deciding which package to draw against
- holiday filtering
- duplicate filtering
- affordability calculation
- delivery insertion
- quota updates
- operational notifications

That's not "handle Claude tool use."

That's:

> **book customer deliveries**

It deserves an actual domain function:

```ts
recordDailyOrder({
  customerId,
  dates,
  mealType,
  portions,
})
```

Claude should merely invoke it.

Then `handleToolUse()` becomes:

```ts
switch (tool.name) {
  case "record_daily_order":
    return recordDailyOrder(...);

  case "extract_order":
    return createOrder(...);

  case "send_menu_image":
    return sendCurrentMenu(...);

  ...
}
```

I'd aim for **50–100 lines**, not 354.

---

# I would revise the architecture like this

Not dozens of micro-"services". That would make things worse.

I'd create about six meaningful modules.

```text
src/app/api/webhook/whatsapp/
└── route.ts

src/lib/whatsapp/inbound/
├── process-webhook.ts
├── idempotency.ts
└── normalize-message.ts

src/lib/chatbot/
├── process-live-message.ts
├── generate-reply.ts
├── execute-tools.ts
└── recovery-guards.ts

src/lib/orders/
└── record-daily-order.ts

src/lib/payments/
└── receive-payment-proof.ts

src/lib/whatsapp/
└── welcome.ts
```

### `route.ts`

Could realistically become ~60–100 lines.

```ts
export async function POST(req: NextRequest) {
  const envelope = await receiveWebhook(req);

  if (!envelope.ok) {
    return envelope.response;
  }

  processWebhookEvent(envelope.payload, envelope.eventId).catch(...);

  return new Response("OK");
}
```

### `process-webhook.ts`

Own:

```text
status update vs inbound
idempotency
customer vs subcontractor routing
customer persistence
```

### `process-live-message.ts`

Own:

```text
takeover
media routing
payment proof routing
burst coalescing
safety gates
welcome
chatbot invocation
```

### `generate-reply.ts`

Own only:

```text
load model context
build prompt
call model
execute tools
validator
translation
sanitization
```

It shouldn't know Meta sent the original webhook.

### `record-daily-order.ts`

Own all the quota/date/holiday/order-selection logic currently buried inside `handleToolUse`.

That function is important enough to be tested almost like accounting code.

---

# There are also things I would absolutely keep

The code isn't bad. In several respects it's quite strong.

Your defense-in-depth around daily orders is good. You're no longer trusting the model merely because the prompt says something. The handler independently checks holidays, quota, duplicate dates and the actual available order before writing.

Your idempotency approach is conceptually right: the **insert**, rather than the preceding select, is correctly recognized as the atomic claim.

The raw-webhook persistence-before-200 design is also good.

And the recovery guards around:

```text
model claimed menu sent
model promised order creation
model promised delivery dates
model claimed it asked admin
```

exist because you've encountered real production failures. I wouldn't throw those away during cleanup.

I'd move them together into something like:

```text
chatbot/recovery-guards.ts
```

and test them heavily.

---

# One more thing I found

You have:

```ts
let replyModelUsed = "sonnet-4-6";
```

around line **2048**.

But the actual call uses:

```ts
model: SONNET_MODEL
```

and your project reference says that role can currently point to DeepSeek.

So your database can record:

```text
sonnet-4-6
```

for a reply that wasn't generated by Sonnet 4.6.

That's bad observability.

Use:

```ts
let replyModelUsed = SONNET_MODEL;
```

or separately record:

```text
role = "sonnet"
model = SONNET_MODEL
```

The same file still has the comment:

```ts
// Call Sonnet 4.6
```

despite using a configurable model constant.

Small bug, but it shows configuration has outgrown some hardcoded assumptions.

---

# What I would do next

I **wouldn't immediately start moving 2,000 lines between files**. That's how you introduce new regressions into an already complicated production system.

I would do this sequence:

1. **Fix the idempotency error handling.**
2. **Make tool handlers return real structured results instead of `void`/`"done"`.**
3. **Fix kill-switch message persistence.**
4. **Fix stale `stateRow` / `menu_shown` state.**
5. **Delete the dead duplicated history/casual/maps block.**
6. Add regression tests for those.
7. **Extract `record_daily_order` first.**
8. Extract payment proof and welcome handling.
9. Extract the chatbot reply engine.
10. Only then shrink `processWebhookAsync()`.

The architectural refactor is justified. But the more important finding from reading the actual code is that **the complexity is already creating correctness defects, not merely ugly code**.

My rating specifically for this file would be roughly **6/10 architecture, 8.5/10 defensive engineering, 5/10 maintainability**. There's a lot of good production learning embodied in it; it just needs to stop accumulating in one control-flow graph.
