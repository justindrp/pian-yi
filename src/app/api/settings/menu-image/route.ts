import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { compressUploadedImage } from "@/lib/images/compress";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_KEYS = ["price_list_image_url"];
type UploadedImage = Awaited<ReturnType<typeof compressUploadedImage>>;

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const key = form.get("key") as string | null;

  if (!file || !key) return NextResponse.json({ ok: false, error: "Missing file or key" }, { status: 400 });
  if (!ALLOWED_KEYS.includes(key)) return NextResponse.json({ ok: false, error: "Invalid key" }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ ok: false, error: "File must be an image" }, { status: 400 });

  let image: UploadedImage;
  try {
    image = await compressUploadedImage(Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Image compression failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const path = `${key}/${Date.now()}.${image.extension}`;

  const db = createAdminClient();
  const { error: uploadError } = await db.storage
    .from("menu-images")
    .upload(path, image.buffer, { contentType: image.contentType, upsert: true });

  if (uploadError) {
    console.error("[menu-image upload]", uploadError.message);
    return NextResponse.json({ ok: false, error: "Upload failed" }, { status: 500 });
  }

  const { data: { publicUrl } } = db.storage.from("menu-images").getPublicUrl(path);

  await db.from("settings").upsert({ key, value: publicUrl }, { onConflict: "key" });
  await db.from("edit_log").insert({
    entity_type: "settings",
    entity_id: key,
    action: "update",
    changed_by: user.email ?? "",
    changes: { [key]: publicUrl },
  });

  invalidateCache();
  return NextResponse.json({ ok: true, url: publicUrl });
}

export const dynamic = "force-dynamic";
