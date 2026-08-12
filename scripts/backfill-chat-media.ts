/**
 * Rescues inbound WhatsApp media before Meta deletes it.
 *
 * One-off rescue for rows saved before the webhook started storing media at
 * receipt time (migration 060 / `src/lib/whatsapp/media-store.ts`). New messages
 * no longer need this.
 *
 * The inbox never stored image bytes — it saved Meta's `media_id` and resolved
 * it live through /api/inbox/media/[mediaId] on every page view. Meta keeps
 * inbound media for roughly a week — the first run of this script found the
 * oldest still-resolvable media_id was 7 days old — so every one of those
 * images eventually 404s and the thread shows a broken placeholder forever.
 *
 * This downloads each still-resolvable media_id into the private `chat-media`
 * bucket and rewrites `conversations.content` (currently the useless literal
 * "[Image]") to the stored URL. `media_id` is deliberately left in place: it is
 * the original Meta reference and nothing is gained by erasing it.
 *
 * Rows whose media has already expired are reported and skipped — those bytes
 * are gone and no script can bring them back.
 *
 * Run:
 *   pnpm tsx scripts/backfill-chat-media.ts          # dry run
 *   pnpm tsx scripts/backfill-chat-media.ts --apply
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const waToken = process.env.WHATSAPP_TOKEN;
const waVersion = process.env.WHATSAPP_API_VERSION ?? "v25.0";

if (!url || !serviceKey || !waToken) {
  console.error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHATSAPP_TOKEN",
  );
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const db = createClient(url, serviceKey);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

async function main() {
  const { data: rows, error } = await db
    .from("conversations")
    .select("id, customer_id, media_id, content, message_type, created_at")
    .not("media_id", "is", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Fetch failed:", error.message);
    process.exit(1);
  }

  console.log(`${rows?.length ?? 0} rows carry a media_id`);
  console.log(apply ? "APPLY mode\n" : "DRY RUN — no writes\n");

  let saved = 0;
  let expired = 0;
  let alreadyDone = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const day = row.created_at?.slice(0, 10) ?? "?";

    if (row.content?.includes("/chat-media/")) {
      alreadyDone++;
      continue;
    }

    // Resolve the media_id to a temporary CDN URL. A 404 here means Meta has
    // already deleted the file.
    const metaRes = await fetch(
      `https://graph.facebook.com/${waVersion}/${row.media_id}`,
      { headers: { Authorization: `Bearer ${waToken}` } },
    );
    if (!metaRes.ok) {
      expired++;
      console.log(`  EXPIRED  ${day}  ${row.media_id}`);
      continue;
    }

    const { url: cdnUrl, mime_type } = (await metaRes.json()) as {
      url: string;
      mime_type?: string;
    };

    const fileRes = await fetch(cdnUrl, {
      headers: { Authorization: `Bearer ${waToken}` },
    });
    if (!fileRes.ok) {
      failed++;
      console.log(`  FETCH ${fileRes.status}  ${day}  ${row.media_id}`);
      continue;
    }

    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const mime = mime_type ?? "image/jpeg";
    const ext = EXT_BY_MIME[mime] ?? "bin";
    const path = `${row.customer_id}/${row.id}.${ext}`;

    if (!apply) {
      saved++;
      console.log(
        `  WOULD SAVE  ${day}  ${row.media_id}  ${(bytes.length / 1024).toFixed(0)}KB  ${mime}`,
      );
      continue;
    }

    const up = await db.storage
      .from("chat-media")
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (up.error) {
      failed++;
      console.log(`  UPLOAD FAIL  ${day}  ${up.error.message}`);
      continue;
    }

    // Public-style URL so it matches the shape already stored for delivery
    // proofs; the bucket is private and the inbox serves it through
    // /api/inbox/chat-media, which signs the path.
    const storedUrl = `${url}/storage/v1/object/public/chat-media/${path}`;
    const upd = await db
      .from("conversations")
      .update({ content: storedUrl })
      .eq("id", row.id);
    if (upd.error) {
      failed++;
      console.log(`  UPDATE FAIL  ${day}  ${upd.error.message}`);
      continue;
    }

    saved++;
    console.log(
      `  SAVED  ${day}  ${(bytes.length / 1024).toFixed(0)}KB  ${path}`,
    );
  }

  console.log(
    `\n${apply ? "saved" : "would save"}: ${saved}  expired: ${expired}  already stored: ${alreadyDone}  failed: ${failed}`,
  );
  if (!apply && saved > 0) {
    console.log("Re-run with --apply to write.");
  }
}

main();
