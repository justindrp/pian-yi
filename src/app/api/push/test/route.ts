import { type NextRequest, NextResponse } from "next/server";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createClient } from "@/lib/supabase/server";

export async function POST(_req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  await sendPushToAllAdmins(
    "Test notification",
    "Push notifications are working!",
    "/dashboard",
    "high",
  );

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
