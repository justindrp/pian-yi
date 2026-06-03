import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const form = await req.formData();
  const file = form.get("file") as File | null;

  if (!file) return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ ok: false, error: "File must be an image" }, { status: 400 });

  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `subcontractors/${id}/${Date.now()}.${ext}`;

  const db = createAdminClient();
  const bytes = await file.arrayBuffer();
  const { error: uploadError } = await db.storage
    .from("menu-images")
    .upload(path, bytes, { contentType: file.type, upsert: true });

  if (uploadError) {
    console.error("[subcontractor menu-image upload]", uploadError.message);
    return NextResponse.json({ ok: false, error: "Upload failed" }, { status: 500 });
  }

  const { data: { publicUrl } } = db.storage.from("menu-images").getPublicUrl(path);

  const { error: updateError } = await db
    .from("subcontractors")
    .update({ menu_image_url: publicUrl, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (updateError) return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });

  await db.from("edit_log").insert({
    entity_type: "subcontractors",
    entity_id: id,
    action: "update",
    changed_by: user.email ?? "",
    changes: { menu_image_url: publicUrl },
  });

  return NextResponse.json({ ok: true, url: publicUrl });
}

export const dynamic = "force-dynamic";
