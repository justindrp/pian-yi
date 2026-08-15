/**
 * Runs the customer chatbot against the live menu-week state, the way the
 * dashboard simulator does, and prints what it would reply.
 *
 * This is the Vania case from 2026-08-15: a customer asks for next week's menu
 * on a Saturday while next week's image is already uploaded. Before
 * menu_week_start existed the bot answered that the menu wasn't out yet and to
 * come back Friday. Pass a date to replay the same question from another day.
 *
 *   tsx scripts/sim-menu-week.ts                 # today
 *   tsx scripts/sim-menu-week.ts 2026-08-19      # once that week has started
 */
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NO_THINKING, SONNET_MODEL } from "../src/lib/claude/client";
import { buildSystemPrompt } from "../src/lib/claude/prompts/system";
import { describeMenuWeeks, jakartaDateString } from "../src/lib/menu/week";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const QUESTIONS = [
  "halo minta menu next week dong",
  "menu hari ini apa ya kak",
];

async function main() {
  const today = process.argv[2] ?? jakartaDateString();

  const { data: activeSubs } = await db
    .from("subcontractors")
    .select(
      "id, customer_nickname, menu_image_url, menu_text, menu_week_start, delivery_areas",
    )
    .eq("is_active", true)
    .not("customer_nickname", "is", null);

  const rawSubs = (activeSubs ?? []).filter((s) => s.customer_nickname !== null);
  const menuWeek = describeMenuWeeks(
    rawSubs.filter((s) => !!s.menu_image_url).map((s) => s.menu_week_start),
    today,
  );

  console.log(`Today: ${today}`);
  console.log(
    `Kitchens with an image: ${rawSubs.filter((s) => s.menu_image_url).length} — menu week ${menuWeek.weekStart ?? "?"} reads as "${menuWeek.relation}"\n`,
  );

  const systemPrompt = await buildSystemPrompt({
    casual: false,
    customerState: "new",
    customerName: null,
    customerNotes: null,
    detectedMapsLink: null,
    menuShown: false,
    dapurOptions: rawSubs
      .filter((s) => !!s.menu_image_url)
      .map((s) => ({ id: s.id, nickname: s.customer_nickname as string })),
    dapurMenuTexts: rawSubs
      .filter((s) => !!s.menu_image_url && !!s.menu_text)
      .map((s) => ({
        nickname: s.customer_nickname as string,
        menuText: s.menu_text as string,
      })),
    menuWeek,
    servedAreas: [
      ...new Set(rawSubs.flatMap((s) => s.delivery_areas ?? [])),
    ].sort(),
    neighborhoods: {},
    activeOrder: null,
  });

  const guidance = systemPrompt
    .split("\n")
    .find((l) => l.includes("menu image on file"));
  console.log(`Prompt line:\n${guidance?.trim()}\n`);

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  for (const q of QUESTIONS) {
    const res = await client.messages.create({
      model: SONNET_MODEL,
      ...NO_THINKING,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: q }],
      tools: [
        {
          name: "send_menu_image",
          description:
            "Sends the menu image(s) currently on file. Which week those cover is stated in your system prompt — check it before you describe what you are sending, and do not claim a week the prompt does not say you have. Safe to call even if the menu was previously sent.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const tools = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => b.name);

    console.log(`> ${q}`);
    console.log(`  tools: ${tools.length ? tools.join(", ") : "(none)"}`);
    console.log(`  ${text.trim() || "(no text)"}\n`);
  }
}

main();
