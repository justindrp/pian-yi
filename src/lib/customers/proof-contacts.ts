import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/utils/phone";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

export type ProofContact = {
  /** The customer whose delivery photos this number may see. */
  ownerId: string;
  ownerName: string | null;
  /** What the owner called this recipient, for the greeting. */
  contactName: string | null;
};

/**
 * The customer a recipient number is allowed to see delivery photos for.
 *
 * Ireine's boxes are received by Abby at a security desk on a different
 * number. Nothing matched that number to Ireine, so Abby asking us for the
 * photo would have been answered "tidak ada jadwal pengiriman untuk kakak" —
 * the proof is keyed on `delivery_proofs.matched_customer_id`, which is the
 * buyer, and a fresh number is a fresh blank customer.
 *
 * The link is proof-only by design, and the restriction lives on the webhook
 * path this feeds, not here: a recipient never sees a price, a quota or a
 * payment state, and cannot order.
 *
 * Numbers are compared in the `+62…` form both sides store, via
 * `normalizePhone`, because an admin types 0812… into the dashboard and
 * WhatsApp hands us +62812….
 */
export async function lookupProofContact(
  db: Db,
  phone: string,
): Promise<ProofContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data } = await db
    .from("customer_contacts")
    .select(
      "name, customer_id, customers!customer_contacts_customer_id_fkey(name)",
    )
    .eq("phone_number", normalized)
    .maybeSingle();
  if (!data) return null;

  const owner = data.customers as { name: string | null } | null;
  return {
    ownerId: data.customer_id,
    ownerName: owner?.name ?? null,
    contactName: data.name,
  };
}

export type ProofRecipient = {
  /** The `customer_contacts` row, for the audit trail. */
  id: string;
  phone: string;
  /** What the owner called them, for the ack and the greeting. */
  name: string | null;
  /**
   * Their own `customers` row, when they have ever written to us. Null for a
   * recipient an admin typed into the dashboard who has never messaged: there
   * is no thread to write the send into and no inbound to measure a window
   * against, so the send goes as a template and is recorded in `edit_log` only.
   */
  customerId: string | null;
};

/**
 * Everyone besides the buyer who should be shown this customer's delivery
 * photos.
 *
 * The push path — the kitchen's photo, or one an admin forwards — had no idea
 * these rows existed: `sendDeliveryPhotoToCustomer` resolves one phone, the
 * buyer's, and sends there. Ireine is the case that made it matter. Her boxes
 * are taken by Abby at a basement security desk, Ireine herself has not written
 * since 14 September so every template send to her dies on 131042, and Abby —
 * who does reply — was getting nothing unless somebody pasted the photo into
 * her chat by hand, which is exactly what happened on 16 September.
 *
 * Read on the send, never cached: a recipient revoked in the dashboard must
 * stop receiving food photos on the next delivery, not on the next deploy.
 */
export async function proofRecipientsFor(
  db: Db,
  ownerId: string,
): Promise<ProofRecipient[]> {
  const { data } = await db
    .from("customer_contacts")
    .select("id, phone_number, name")
    .eq("customer_id", ownerId);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  // One query for the whole set rather than one per recipient — the common
  // case is a single contact, but the shape should not degrade if a customer
  // ever has several.
  const { data: own } = await db
    .from("customers")
    .select("id, phone_number")
    .in(
      "phone_number",
      rows.map((r) => r.phone_number),
    );
  const byPhone = new Map((own ?? []).map((c) => [c.phone_number, c.id]));

  return rows.map((r) => ({
    id: r.id,
    phone: r.phone_number,
    name: r.name,
    customerId: byPhone.get(r.phone_number) ?? null,
  }));
}
