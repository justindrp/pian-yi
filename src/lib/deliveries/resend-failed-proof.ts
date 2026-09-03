import { sendDeliveryPhotoToCustomer } from "@/lib/claude/photo-matcher";
import { jakartaDateString } from "@/lib/menu/week";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resends today's delivery photo when the first attempt failed.
 *
 * A proof is pushed the moment the kitchen's photo arrives, which is a
 * business-initiated send: if the customer has not written to us in 24 hours it
 * leaves as a template and fails on `131042` — the WABA payment restriction —
 * and nothing retries it. On 2026-09-03 at 19:07 Clairine Aurelia's photo
 * failed that way; she wrote in at 19:15 asking for it, which is the only
 * reason anyone found out. Her messaging is also what reopens the window, so
 * the retry belongs on her next inbound message and nowhere else.
 *
 * Runs before the model call so the photo is already in the history it loads,
 * rather than arriving underneath a reply saying we hold nothing.
 *
 * Today only. A photo of food eaten yesterday is not an answer to anything the
 * customer is asking now, and `send_delivery_proof` is there for a day they
 * name themselves.
 */
export async function resendFailedProofs(customerId: string): Promise<number> {
  const db = createAdminClient();
  const today = jakartaDateString();

  const { data: rows } = await db
    .from("conversations")
    .select("media_url, whatsapp_status")
    .eq("customer_id", customerId)
    .eq("role", "assistant")
    .eq("message_type", "image")
    .gte("created_at", `${today}T00:00:00+07:00`)
    .lt("created_at", `${today}T23:59:59.999+07:00`);

  const proofs = (rows ?? []).filter((r) =>
    r.media_url?.includes("/delivery-proofs/"),
  );
  // A send that did not fail is one the customer has, so its photo is done —
  // including the resend this function itself wrote on an earlier message of
  // the same burst. Keyed on the file, because a resend is a second row for
  // the same picture.
  const arrived = new Set(
    proofs
      .filter((r) => r.whatsapp_status !== "failed")
      .map((r) => r.media_url as string),
  );
  const failed = [
    ...new Set(
      proofs
        .filter((r) => r.whatsapp_status === "failed")
        .map((r) => r.media_url as string)
        .filter((url) => !arrived.has(url)),
    ),
  ];

  let sent = 0;
  for (const url of failed) {
    const { data: proof } = await db
      .from("delivery_proofs")
      .select("id")
      .eq("image_url", url)
      .maybeSingle();
    if (!proof) continue;
    // Sends it the way the first attempt did, minus the closed window: the
    // customer has just written, so this leaves as a plain image with its
    // caption instead of the template that 131042 blocks.
    await sendDeliveryPhotoToCustomer(proof.id, customerId);
    sent++;
  }
  if (sent > 0)
    console.log(
      `[webhook] resent ${sent} failed delivery photo(s) for ${customerId}`,
    );
  return sent;
}
