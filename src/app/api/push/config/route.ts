import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  // Match this browser's own subscription, not any subscription for the email —
  // otherwise a second device sees hasSubscription: true and can never enable push
  const endpoint = req.nextUrl.searchParams.get("endpoint");
  if (!endpoint) {
    return NextResponse.json({
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
      hasSubscription: false,
    });
  }

  const { count } = await supabase
    .from("push_subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("user_email", user.email ?? "")
    .eq("endpoint", endpoint);

  return NextResponse.json({
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    hasSubscription: (count ?? 0) > 0,
  });
}

export const dynamic = "force-dynamic";
