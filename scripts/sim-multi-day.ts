/**
 * Replays Tio Jason's 2026-08-18 conversation against the live prompt and the
 * fixed record_daily_order schema, and prints EVERY tool_use block with its
 * input — which is the whole point: the webhook used to keep only the last one,
 * and the tool took a single date, so his eight-day Senin–Jumat run booked one
 * delivery. A pass here is one call carrying every ISO date.
 *
 *   tsx scripts/sim-multi-day.ts              # the Tio script
 *   tsx scripts/sim-multi-day.ts 2026-08-18   # pin "today"
 */
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NO_THINKING, SONNET_MODEL } from "../src/lib/claude/client";
import { buildSystemPrompt } from "../src/lib/claude/prompts/system";
import { sanitizeReply } from "../src/lib/claude/sanitize-reply";
import { describeMenuWeeks, jakartaDateString } from "../src/lib/menu/week";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

// Tio's actual turns, in order. The last one is where it went wrong live.
const SCRIPT = [
  "mau lanjut cateringnya lagi",
  "masi ada brp ya kuota sya",
  "lanjutin dulu aja",
  "buat senin-jumat, siang",
  "rabu besok",
  "iya",
];

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "record_daily_order",
    description:
      "Called when a customer with an active quota-based order requests one or more deliveries. Inserts a daily delivery row per date and decrements their quota. Pass EVERY date the customer agreed to in one call — a Senin–Jumat run is one call with five dates, never five calls. Only call this for customers who already have an active order with portions_remaining > 0.",
    input_schema: {
      type: "object",
      properties: {
        delivery_dates: {
          type: "array",
          items: { type: "string" },
          description:
            "Every requested delivery date as ISO YYYY-MM-DD. One entry for a single day; all of them for a multi-day schedule.",
        },
        meal_type: { type: "string", enum: ["lunch", "dinner", "both"] },
        portions: {
          type: "number",
          description:
            "Portions per delivery date, not the total. Total deducted is this number times the number of dates.",
        },
        notes: { type: "string" },
      },
      required: ["delivery_dates", "meal_type", "portions"],
    },
  },
  {
    name: "ask_admin_for_help",
    description: "Called when the bot is uncertain about the answer.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--rem="));
  const remArg = process.argv.find((a) => a.startsWith("--rem="));
  // Quota left on the simulated order — drop it below the days asked for to
  // exercise the "never agree to more days than the quota covers" rule.
  const remaining = remArg ? Number(remArg.slice(6)) : 15;
  const today = args[0] ?? jakartaDateString();
  // Any further args replace the Tio script, so a phrasing can be replayed
  // without editing this file.
  const script = args.length > 1 ? args.slice(1) : SCRIPT;

  const { data: activeSubs } = await db
    .from("subcontractors")
    .select(
      "id, customer_nickname, menu_image_url, menu_text, menu_week_start, delivery_areas, offers_size_m",
    )
    .eq("is_active", true)
    .not("customer_nickname", "is", null);
  const rawSubs = (activeSubs ?? []).filter(
    (s) => s.customer_nickname !== null,
  );

  // Tio's real state: 15 of 40 portions left, 1 porsi per meal, bebas.
  const systemPrompt = await buildSystemPrompt({
    casual: false,
    customerState: "active",
    customerName: "Tio Jason",
    customerNotes: null,
    detectedMapsLink: null,
    menuShown: true,
    dapurOptions: rawSubs
      .filter((s) => !!s.menu_image_url)
      .map((s) => ({
        id: s.id,
        nickname: s.customer_nickname as string,
        offersM: s.offers_size_m === true,
      })),
    dapurMenuTexts: [],
    menuWeek: describeMenuWeeks(
      rawSubs.filter((s) => !!s.menu_image_url).map((s) => s.menu_week_start),
      today,
    ),
    servedAreas: [
      ...new Set(rawSubs.flatMap((s) => s.delivery_areas ?? [])),
    ].sort(),
    neighborhoods: {},
  coverageNotes: [],
    activeOrder: {
      id: "sim-order",
      packageSize: 40,
      portionsPerDelivery: 1,
    },
    // Quota is customer-level and lives here now, not on activeOrder.
    schedule: { upcoming: [], remainingToday: remaining, unbooked: remaining },
  });

  console.log(
    `Today: ${today} — active order ${remaining}/40, 1 porsi/meal, per_day_decision\n`,
  );

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  const history: Anthropic.Messages.MessageParam[] = [];
  let booked = 0;

  for (const turn of script) {
    history.push({ role: "user", content: turn });

    const res = await client.messages.create({
      model: SONNET_MODEL,
      ...NO_THINKING,
      max_tokens: 1500,
      system: systemPrompt,
      messages: history,
      tools: TOOLS,
    });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    let reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (toolUses.length > 0 && !reply) {
      const followUp = await client.messages.create({
        model: SONNET_MODEL,
        ...NO_THINKING,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          ...history,
          { role: "assistant", content: res.content },
          {
            role: "user",
            content: toolUses.map((t) => ({
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: "done",
            })),
          },
        ],
        tools: TOOLS,
      });
      reply = followUp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    }

    reply = sanitizeReply(reply);

    console.log(`> ${turn}`);
    for (const t of toolUses) {
      const input = t.input as { delivery_dates?: string[] };
      if (
        t.name === "record_daily_order" &&
        Array.isArray(input.delivery_dates)
      ) {
        booked += input.delivery_dates.length;
      }
      console.log(`  TOOL ${t.name} ${JSON.stringify(t.input)}`);
    }
    console.log(`  ${reply || "(no text)"}\n`);

    history.push({
      role: "assistant",
      content: reply || "(tool call)",
    });
  }

  console.log(`=== dates booked across the whole conversation: ${booked}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
