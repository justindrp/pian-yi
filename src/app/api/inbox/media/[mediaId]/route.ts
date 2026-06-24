import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { mediaId } = await params;
  const token = process.env.WHATSAPP_TOKEN;
  const version = process.env.WHATSAPP_API_VERSION;

  // Get media URL from Meta
  const metaRes = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    return NextResponse.json({ ok: false, error: "Media not found" }, { status: 404 });
  }
  const { url, mime_type } = (await metaRes.json()) as { url: string; mime_type: string };

  // Proxy the image
  const imgRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!imgRes.ok) {
    return NextResponse.json({ ok: false, error: "Failed to fetch media" }, { status: 502 });
  }

  const buffer = await imgRes.arrayBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": mime_type ?? "image/jpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
