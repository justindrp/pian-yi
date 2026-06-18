import type Anthropic from "@anthropic-ai/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    hasActiveOrder?: boolean;
  };

  const db = createAdminClient();

  const { data: activeSubs } = await db
    .from("subcontractors")
    .select("id, customer_nickname, menu_image_url, menu_text, delivery_areas")
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
      delivery_areas: string[] | null;
    } => s.customer_nickname !== null,
  );

  const dapurOptions = rawSubs
    .filter((s) => !!s.menu_image_url)
    .map((s) => ({ id: s.id, nickname: s.customer_nickname }));

  const dapurMenuTexts = rawSubs
    .filter((s) => !!s.menu_image_url && !!s.menu_text)
    .map((s) => ({ nickname: s.customer_nickname, menuText: s.menu_text as string }));

  const servedAreas = [
    ...new Set(rawSubs.flatMap((s) => s.delivery_areas ?? [])),
  ].sort();

  const activeOrder = body.hasActiveOrder
    ? {
        id: "sim-order",
        portionsRemaining: 30,
        packageSize: 50,
        portionsPerDelivery: 1,
        mealTimePreference: "per_day_decision",
      }
    : null;

  const systemPrompt = await buildSystemPrompt({
    casual: false,
    customerState: body.hasActiveOrder ? "active" : "new",
    customerName: null,
    detectedMapsLink: null,
    menuShown: true,
    dapurOptions,
    dapurMenuTexts,
    servedAreas,
    activeOrder,
  });

  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "extract_order",
      description:
        "Called when customer has confirmed their order summary with YA. Extracts all order details.",
      input_schema: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          package_size: { type: "number" },
          portions_per_delivery: { type: "number" },
          address: { type: "string" },
          maps_link: { type: "string" },
          area: {
            type: "string",
            enum: ["BSD Baru", "BSD Lama", "Gading Serpong", "Alam Sutera", "Karawaci"],
          },
          sub_area: { type: "string" },
          meal_time_preference: {
            type: "string",
            enum: [
              "lunch_only",
              "dinner_only",
              "both_fixed",
              "per_day_decision",
              "default_lunch",
              "default_dinner",
              "custom_schedule",
            ],
          },
          start_date: { type: "string" },
          end_date: { type: "string" },
          subcontractor_id: { type: "string" },
        },
        required: [
          "customer_name",
          "package_size",
          "portions_per_delivery",
          "address",
          "maps_link",
          "area",
          ...(dapurOptions.length > 0 ? ["subcontractor_id"] : []),
        ],
      },
    },
    {
      name: "record_daily_order",
      description:
        "Called when a customer with an active quota-based order requests a delivery for the next day.",
      input_schema: {
        type: "object",
        properties: {
          delivery_date: { type: "string" },
          meal_type: { type: "string", enum: ["lunch", "dinner", "both"] },
          portions: { type: "number" },
          notes: { type: "string" },
        },
        required: ["delivery_date", "meal_type", "portions"],
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
      description: "Called when the conversation must be fully handed off to Annie.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    {
      name: "mark_payment_proof_received",
      description: "Called when customer indicates they have sent payment proof.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: body.messages as Anthropic.Messages.MessageParam[],
    tools,
  });

  let reply = "";
  let toolCalled: { name: string; input: unknown } | null = null;

  for (const block of response.content) {
    if (block.type === "text") reply = block.text;
    if (block.type === "tool_use") toolCalled = { name: block.name, input: block.input };
  }

  return NextResponse.json({ ok: true, reply, toolCalled });
}

export const dynamic = "force-dynamic";
