import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await params;
  const storagePath = path.join("/");
  if (!storagePath) {
    return NextResponse.json({ ok: false, error: "Missing storage path" }, { status: 400 });
  }

  const db = createAdminClient();
  const { data, error } = await db.storage
    .from("delivery-proofs")
    .createSignedUrl(storagePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json({ ok: false, error: "Image not found" }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl);
}

export const dynamic = "force-dynamic";
