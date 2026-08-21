/**
 * Sends one image to a customer and logs it to conversations, the way the inbox
 * compose box does. The photo half of scripts/manual-send.ts.
 *   tsx --env-file=.env.local scripts/manual-send-image.ts +62... ./photo.jpg "caption" [--apply]
 *
 * The env file has to come from node, not a dotenv call in here: BASE_URL in
 * whatsapp/client.ts is built at module load, and imports are hoisted above
 * anything this file runs, so a late dotenv.config() posts to /undefined/media.
 */
import { readFile } from "node:fs/promises";
import { compressUploadedImage } from "../src/lib/images/compress";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  sendImageMessageById,
  uploadMediaToMeta,
} from "../src/lib/whatsapp/client";

async function main() {
  const [phone, filePath, caption] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: cust } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (!cust) throw new Error(`no customer ${phone}`);

  const { data: last } = await db
    .from("conversations")
    .select("created_at")
    .eq("customer_id", cust.id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const hours = last?.created_at
    ? (Date.now() - new Date(last.created_at).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  const image = await compressUploadedImage(await readFile(filePath));
  console.log(
    `${cust.name ?? "(no name)"} ${phone} — window ${hours < 24 ? "OPEN" : "SHUT"} (${hours.toFixed(1)}h)\n` +
      `${filePath} → ${image.buffer.length} bytes ${image.contentType}\n${caption}\n`,
  );
  if (!apply) return console.log("dry run — pass --apply");
  if (hours >= 24) throw new Error("window shut");

  const storagePath = `inbox/${cust.id}/${Date.now()}.${image.extension}`;
  const { error: uploadErr } = await db.storage
    .from("menu-images")
    .upload(storagePath, image.buffer, {
      contentType: image.contentType,
      upsert: false,
    });
  if (uploadErr) throw uploadErr;
  const {
    data: { publicUrl },
  } = db.storage.from("menu-images").getPublicUrl(storagePath);

  // Meta serves the image from its own CDN — sending by link fails silently.
  const mediaId = await uploadMediaToMeta(image.buffer, image.contentType);
  const messageId = await sendImageMessageById(phone, mediaId, caption ?? "");

  await db.from("conversations").insert({
    customer_id: cust.id,
    role: "assistant",
    content: publicUrl,
    message_id: messageId,
    message_type: "image",
    model_used: "human",
    // Nobody pressed a button in the dashboard for this one.
    sent_by: "script:manual-send-image",
    whatsapp_status: "sent",
    whatsapp_status_updated_at: new Date().toISOString(),
  });
  await db
    .from("customer_flags")
    .update({
      last_human_activity_at: new Date().toISOString(),
      pending_bot_response: false,
      pending_bot_question: null,
    })
    .eq("customer_id", cust.id);

  console.log(`sent — ${messageId}\n${publicUrl}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
