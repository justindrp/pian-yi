import { createAdminClient } from "@/lib/supabase/admin";
import { downloadMedia } from "./client";

// Meta deletes inbound media after roughly a week, so a `media_id` alone is not
// a durable reference — it has to be resolved to bytes while it still works.
// Everything inbound lands in the private `chat-media` bucket and is served
// through /api/inbox/chat-media, which signs the path per request.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

// Storage keys are ASCII-safe so the URL survives the round trip through
// getPublicUrl and back out of the inbox's path parser.
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "dokumen";
}

/**
 * Downloads inbound WhatsApp media and stores it, returning the stored URL.
 * Returns null on any failure — losing a stored copy must never cost the
 * customer their reply, so callers save the message either way.
 */
export async function storeInboundMedia(params: {
  mediaId: string;
  customerId: string;
  mimeType?: string;
  filename?: string;
}): Promise<string | null> {
  try {
    const bytes = await downloadMedia(params.mediaId);
    const mime = params.mimeType ?? "image/jpeg";
    const path = params.filename
      ? `${params.customerId}/${params.mediaId}/${safeFilename(params.filename)}`
      : `${params.customerId}/${params.mediaId}.${EXT_BY_MIME[mime] ?? "bin"}`;

    const db = createAdminClient();
    const { error } = await db.storage
      .from("chat-media")
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (error) {
      console.error("[chat-media] upload failed:", error.message);
      return null;
    }

    return db.storage.from("chat-media").getPublicUrl(path).data.publicUrl;
  } catch (err) {
    console.error(
      "[chat-media] download failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
