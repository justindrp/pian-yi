import { type NextRequest, NextResponse } from "next/server";
import { replayLatestCustomerMessage } from "@/lib/inbox/replay-latest";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { customer_id: string; draft?: boolean };
  const { customer_id, draft = false } = body;

  if (!customer_id) {
    return NextResponse.json({ ok: false, error: "customer_id required" }, { status: 400 });
  }

  const result = await replayLatestCustomerMessage(
    customer_id,
    createAdminClient(),
    { draft },
  );

  if (result.status) {
    return NextResponse.json(
      { ok: false, error: result.reason },
      { status: result.status },
    );
  }

  if (!result.replayed) {
    return NextResponse.json({ ok: true, replayed: false, reason: result.reason });
  }

  return draft
    ? NextResponse.json({ ok: true, replayed: true, draft: result.draft })
    : NextResponse.json({ ok: true, replayed: true });
}

export const dynamic = "force-dynamic";
