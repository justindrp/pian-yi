import { type NextRequest, NextResponse } from "next/server";
import { compressUploadedImage } from "@/lib/images/compress";
import { defaultMenuWeekStart, jakartaDateString } from "@/lib/menu/week";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type UploadedImage = Awaited<ReturnType<typeof compressUploadedImage>>;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { id } = await params;
  const form = await req.formData();
  const file = form.get("file") as File | null;

  if (!file)
    return NextResponse.json(
      { ok: false, error: "Missing file" },
      { status: 400 },
    );
  if (!file.type.startsWith("image/"))
    return NextResponse.json(
      { ok: false, error: "File must be an image" },
      { status: 400 },
    );

  let image: UploadedImage;
  try {
    image = await compressUploadedImage(Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Image compression failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const path = `subcontractors/${id}/${Date.now()}.${image.extension}`;

  const db = createAdminClient();
  const { error: uploadError } = await db.storage
    .from("menu-images")
    .upload(path, image.buffer, {
      contentType: image.contentType,
      upsert: true,
    });

  if (uploadError) {
    console.error("[subcontractor menu-image upload]", uploadError.message);
    return NextResponse.json(
      { ok: false, error: "Upload failed" },
      { status: 500 },
    );
  }

  const {
    data: { publicUrl },
  } = db.storage.from("menu-images").getPublicUrl(path);

  // Which week the image covers decides whether the bot may send it as "next
  // week's menu". The uploader may state it outright; the day-of-week default is
  // only a guess, and a wrong one often enough that the form shows the value
  // back for correction (Batch 50 went up on a Thursday for the following week).
  const stated = form.get("menu_week_start");
  const menuWeekStart =
    typeof stated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stated)
      ? stated
      : defaultMenuWeekStart(jakartaDateString());

  const { error: updateError } = await db
    .from("subcontractors")
    .update({
      menu_image_url: publicUrl,
      menu_week_start: menuWeekStart,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError)
    return NextResponse.json(
      { ok: false, error: updateError.message },
      { status: 500 },
    );

  await db.from("edit_log").insert({
    entity_type: "subcontractors",
    entity_id: id,
    action: "update",
    changed_by: user.email ?? "",
    changes: { menu_image_url: publicUrl, menu_week_start: menuWeekStart },
  });

  return NextResponse.json({
    ok: true,
    url: publicUrl,
    menu_week_start: menuWeekStart,
  });
}

export const dynamic = "force-dynamic";
