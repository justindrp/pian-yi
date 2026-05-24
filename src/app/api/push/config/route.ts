import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  return NextResponse.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "" });
}

export const dynamic = "force-dynamic";
