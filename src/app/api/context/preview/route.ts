import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";
import { getNeighborhoods } from "@/lib/cache/settings";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

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

  const neighborhoods = await getNeighborhoods();

  const prompt = await buildSystemPrompt({
    casual: false,
    customerState: "browsing",
    customerName: null,
    customerNotes: null,
    detectedMapsLink: null,
    menuShown: false,
    dapurOptions,
    dapurMenuTexts,
    servedAreas,
    neighborhoods,
    activeOrder: null,
  });

  return NextResponse.json({ ok: true, prompt });
}
