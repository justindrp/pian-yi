import { NextResponse } from "next/server";
import { jakartaDateString } from "@/lib/menu/week";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

/**
 * Claim today's automatic morning briefing. Returns `{ claimed: true }` to
 * exactly one caller per Jakarta day; everyone else gets `{ claimed: false }`.
 *
 * The insert is the guard, not a preceding select — `brief_date` is the primary
 * key, so two devices opening the assistant at the same moment resolve to one
 * winner and one unique violation. The client used to decide this from
 * localStorage, which is per-browser, so a phone and a laptop each ran their
 * own "once per day" and the admin got the briefing twice.
 */
export async function POST() {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const { error } = await db
    .from("assistant_daily_briefs")
    .insert({ brief_date: jakartaDateString() });

  // A unique violation means another device already claimed today. Anything
  // else is a real failure, and the safe answer is still "don't send" — a
  // missing briefing is a smaller annoyance than a duplicate one.
  if (error) {
    if (error.code !== "23505") {
      console.error("[assistant/daily-brief] claim failed:", error.message);
    }
    return NextResponse.json({ ok: true, claimed: false });
  }

  return NextResponse.json({ ok: true, claimed: true });
}

export const dynamic = "force-dynamic";
