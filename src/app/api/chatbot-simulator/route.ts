import type Anthropic from "@anthropic-ai/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { DELIVERY_WINDOWS, windowLabel } from "@/lib/deliveries/windows";
import {
  getExcludedNeighborhoods,
  getNeighborhoods,
} from "@/lib/cache/settings";
import {
  getAnthropicClient,
  NO_THINKING,
  SONNET_MODEL,
} from "@/lib/claude/client";
import { extractOrderProperties } from "@/lib/claude/extract-order";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";
import { describeMenuWeeks, jakartaDateString } from "@/lib/menu/week";
import { unionAreas } from "@/lib/subcontractors/areas";
import { coverageNotes } from "@/lib/subcontractors/coverage";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { addDays } from "@/lib/time/jakarta";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    hasActiveOrder?: boolean;
  };

  const db = createAdminClient();

  const { data: activeSubs } = await db
    .from("subcontractors")
    .select(
      "id, customer_nickname, menu_image_url, menu_text, menu_week_start, delivery_areas, offers_size_m, same_menu_both_meals",
    )
    .eq("is_active", true)
    .not("customer_nickname", "is", null);

  const rawSubs = (activeSubs ?? []).filter(
    (
      s,
    ): s is {
      id: string;
      customer_nickname: string;
      menu_image_url: string | null;
      menu_text: string | null;
      menu_week_start: string | null;
      delivery_areas: string[] | null;
      offers_size_m: boolean;
      same_menu_both_meals: boolean;
    } => s.customer_nickname !== null,
  );

  const dapurOptions = rawSubs
    .filter((s) => !!s.menu_image_url)
    .map((s) => ({
      id: s.id,
      nickname: s.customer_nickname,
      offersM: s.offers_size_m === true,
      sameMenuBothMeals: s.same_menu_both_meals === true,
    }));

  const dapurMenuTexts = rawSubs
    .filter((s) => !!s.menu_image_url && !!s.menu_text)
    .map((s) => ({
      nickname: s.customer_nickname,
      menuText: s.menu_text as string,
    }));

  const servedAreas = unionAreas(rawSubs);

  const neighborhoods = await getNeighborhoods();
  const excludedNeighborhoods = await getExcludedNeighborhoods();
  const kitchenCoverageNotes = await coverageNotes(db, rawSubs);

  const activeOrder = body.hasActiveOrder
    ? {
        id: "sim-order",
        packageSize: 50,
        portionsPerDelivery: 1,
      }
    : null;

  // A stand-in schedule so training mode exercises the jadwal block the real
  // bot gets. The two numbers are deliberately different: 32 meals still to
  // come, 30 of them without a date yet.
  const schedule = body.hasActiveOrder
    ? {
        remainingToday: 32,
        unbooked: 30,
        upcoming: [
          {
            date: addDays(jakartaDateString(), 1),
            mealType: "lunch",
            portions: 1,
            // The window is per kitchen and this schedule belongs to no
            // kitchen, so training mode shows the fallback.
            window: windowLabel(
              DELIVERY_WINDOWS.lunch.startMin,
              DELIVERY_WINDOWS.lunch.endMin,
            ),
          },
          {
            date: addDays(jakartaDateString(), 2),
            mealType: "dinner",
            portions: 1,
            window: windowLabel(
              DELIVERY_WINDOWS.dinner.startMin,
              DELIVERY_WINDOWS.dinner.endMin,
            ),
          },
        ],
      }
    : null;

  const systemPrompt = await buildSystemPrompt({
    casual: false,
    customerState: body.hasActiveOrder ? "active" : "new",
    customerName: null,
    customerNotes: null,
    detectedMapsLink: null,
    menuShown: false,
    dapurOptions,
    dapurMenuTexts,
    menuWeek: describeMenuWeeks(
      rawSubs.filter((s) => !!s.menu_image_url).map((s) => s.menu_week_start),
    ),
    servedAreas,
    neighborhoods,
    excludedNeighborhoods,
    coverageNotes: kitchenCoverageNotes,
    activeOrder,
    schedule,
  });

  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "extract_order",
      description:
        "Called when customer has confirmed their order summary with YA. Extracts all order details.",
      input_schema: {
        type: "object",
        // The shared schema, not a copy. This file used to hold its own — with
        // its own five-name area enum and no `delivery_schedule` — so the
        // simulator was testing a tool the live bot does not have.
        properties: extractOrderProperties(servedAreas),
        required: [
          "customer_name",
          "package_size",
          "portions_per_delivery",
          "address",
          "maps_link",
          "area",
          "size",
          ...(dapurOptions.length > 0 ? ["subcontractor_id"] : []),
        ],
      },
    },
    {
      name: "record_daily_order",
      description:
        "Called when a customer with an active quota-based order requests one or more deliveries. Pass EVERY agreed date in one call — a Senin–Jumat run is one call with five dates.",
      input_schema: {
        type: "object",
        properties: {
          delivery_dates: { type: "array", items: { type: "string" } },
          meal_type: { type: "string", enum: ["lunch", "dinner", "both"] },
          portions: { type: "number" },
          notes: { type: "string" },
        },
        required: ["delivery_dates", "meal_type", "portions"],
      },
    },
    {
      name: "delete_deliveries",
      description:
        "Removes dates from the customer's delivery schedule — a skip, a cancellation, or the first half of moving a meal (call record_daily_order for the new date in the same message). The portions go back into their balance. A TERKUNCI date is refused.",
      input_schema: {
        type: "object",
        properties: {
          delivery_dates: { type: "array", items: { type: "string" } },
          meal_type: { type: "string", enum: ["lunch", "dinner", "both"] },
          reason: { type: "string" },
        },
        required: ["delivery_dates"],
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
    {
      name: "escalate_to_human",
      description:
        "Called when the conversation must be fully handed off to an admin.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    {
      name: "mark_payment_proof_received",
      description:
        "Called when customer indicates they have sent payment proof.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    ...NO_THINKING,
    max_tokens: 1000,
    system: systemPrompt,
    messages: body.messages as Anthropic.Messages.MessageParam[],
    tools,
  });

  let reply = "";
  let toolCalled: { name: string; input: unknown } | null = null;

  for (const block of response.content) {
    if (block.type === "text") reply = block.text;
    if (block.type === "tool_use")
      toolCalled = { name: block.name, input: block.input };
  }

  return NextResponse.json({ ok: true, reply, toolCalled });
}

export const dynamic = "force-dynamic";
