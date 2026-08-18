/**
 * Banks a payment-proof image the webhook saved as a plain "[Image]" — what
 * happened while a thread was parked or taken over, before those branches
 * captured proofs. Copies the bytes into payment-proofs, points the order's
 * payment_proof_url at them and moves it to payment_proof_received, so the
 * Payments page's Pending verification tab shows it.
 *
 *   tsx scripts/rescue-payment-proof.ts +62... [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { downloadMedia } from "../src/lib/whatsapp/client";

async function main() {
  const phone = process.argv[2];
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: cust } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (!cust) throw new Error(`no customer ${phone}`);

  const { data: order } = await db
    .from("orders")
    .select("id, status, total_price")
    .eq("customer_id", cust.id)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!order) throw new Error("no pending_payment order");

  const { data: img } = await db
    .from("conversations")
    .select("id, created_at, content, media_id, media_url")
    .eq("customer_id", cust.id)
    .eq("role", "user")
    .eq("message_type", "image")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!img) throw new Error("no inbound image on this thread");

  console.log(`order ${order.id.slice(0, 8)} ${order.status} Rp${order.total_price}`);
  console.log(`image ${img.created_at} content=${String(img.content).slice(0, 40)} media_id=${img.media_id ?? "-"}`);
  if (!apply) return console.log("dry run — pass --apply");

  let url = img.media_url;
  if (img.media_id) {
    try {
      const buf = await downloadMedia(img.media_id);
      const path = `${cust.id}/${String(img.created_at).slice(0, 10)}/${img.id}.jpg`;
      const { error } = await db.storage
        .from("payment-proofs")
        .upload(path, buf, { contentType: "image/jpeg", upsert: true });
      if (error) throw new Error(error.message);
      url = db.storage.from("payment-proofs").getPublicUrl(path).data.publicUrl;
    } catch (err) {
      console.error("copy to payment-proofs failed:", (err as Error).message);
    }
  }

  await db.from("orders")
    .update({ status: "payment_proof_received", payment_proof_url: url })
    .eq("id", order.id);
  await db.from("conversations")
    .update({ content: url ?? "[Bukti pembayaran dikirim]" })
    .eq("id", img.id);
  console.log("order -> payment_proof_received");
  console.log("proof:", url);
}
main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
