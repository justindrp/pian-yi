import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";

interface BroadcastFilter {
  areas?: string[];
  statuses?: string[];
  subcontractor_id?: string | null;
  all_active?: boolean;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { instruction } = await req.json() as { instruction: string };
  if (!instruction?.trim()) return NextResponse.json({ ok: false, error: "instruction required" }, { status: 400 });

  const db = createAdminClient();

  // Load context for Claude: available areas and subcontractors
  const [{ data: subs }, { data: areaRows }] = await Promise.all([
    db.from("subcontractors").select("id, name, customer_nickname").eq("is_active", true),
    db.from("customers").select("area").not("area", "is", null),
  ]);

  const uniqueAreas = [...new Set((areaRows ?? []).map((r) => r.area).filter(Boolean))];
  const subList = (subs ?? []).map((s) => `${s.id} (${s.name} / ${s.customer_nickname})`).join(", ");

  const systemPrompt = `You are a targeting assistant for a catering business in Indonesia. Your job is to interpret an admin's broadcast instruction and return:
1. A customer filter (JSON)
2. A WhatsApp message template in Indonesian

Available areas: ${uniqueAreas.join(", ")}
Available subcontractors (id / name / nickname): ${subList || "none"}
Available order statuses: active, pending_payment, paused

Filter JSON shape:
{
  "areas": ["area1"],         // optional, filter by delivery area
  "statuses": ["active"],     // optional, filter by order status (default: active only)
  "subcontractor_id": "uuid", // optional, filter by subcontractor
  "all_active": true          // set to true if targeting all active customers
}

Message template rules:
- Written in Indonesian, warm and friendly
- Start with "Halo kak {name}," — always use {name} placeholder
- Under 150 words
- No subcontractor names (Santapin, Thenie) — say "kami" instead
- No bank account details

Respond ONLY with valid JSON in this exact shape:
{
  "filter": { ... },
  "message_template": "..."
}`;

  const claude = getAnthropicClient();
  const response = await claude.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: "user", content: instruction }],
  });

  let filter: BroadcastFilter;
  let message_template: string;

  try {
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(text) as { filter: BroadcastFilter; message_template: string };
    filter = parsed.filter;
    message_template = parsed.message_template;
  } catch {
    return NextResponse.json({ ok: false, error: "AI failed to parse instruction. Please rephrase." }, { status: 422 });
  }

  // Query matching customers
  let query = db
    .from("customers")
    .select("id, name, phone_number, area, subcontractor_id, orders!inner(status, subcontractor_id)")
    .not("phone_number", "is", null);

  const statuses = filter.statuses?.length ? filter.statuses : ["active"];
  query = query.in("orders.status", statuses);

  if (filter.areas?.length) {
    query = query.in("area", filter.areas);
  }

  if (filter.subcontractor_id) {
    query = query.eq("subcontractor_id", filter.subcontractor_id);
  }

  const { data: customers } = await query;

  // Deduplicate by customer id (one customer may have multiple orders)
  const seen = new Set<string>();
  const recipients = (customers ?? [])
    .filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
    .map((c) => ({
      customer_id: c.id,
      name: c.name ?? "Kak",
      phone_number: c.phone_number,
      area: c.area,
      personalized_message: message_template.replace(/\{name\}/g, c.name ?? "Kak"),
    }));

  return NextResponse.json({
    ok: true,
    data: {
      filter,
      message_template,
      recipients,
    },
  });
}

export const dynamic = "force-dynamic";
