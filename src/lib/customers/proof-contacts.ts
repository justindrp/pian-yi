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
