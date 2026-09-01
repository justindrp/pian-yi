import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

export interface PaymentProof {
  /** Public `payment-proofs` bucket URL, straight from `orders`. */
  url: string;
  /** Whose package it is — not always whose name is on the transfer. */
  customer: string | null;
  orderId: string;
}

/**
 * The transfer screenshot behind a customer-payment journal, keyed by journal.
 *
 * A payment journal is two account codes and a number, and that is exactly as
 * much as a bank line is. Neither says whether the money that arrived is the
 * money the entry claims — the reconciliation on 2026-09-01 turned on evidence
 * the ledger could not show: a Rp 145.001 credit was Gracia's because her
 * proof landed at 23:38 the night before, and Sharleen's Rp 212.000 was ongkir
 * rather than a package because she wrote "Itu bukti transfer ongkirnya" with
 * the image. The proof is already stored on the order; this only carries it
 * across to the entry, so checking one no longer means opening the inbox.
 *
 * Only `order_payment` journals have one. Roughly a third of paid orders still
 * have no `payment_proof_url` at all — anything imported, anything paid before
 * the webhook started banking the image, anything an admin marked paid by hand
 * — so a null here is the normal case and never an error.
 */
export async function paymentProofsByJournal(
  db: Db,
  journals: {
    id: string;
    source_type: string | null;
    source_id: string | null;
  }[],
): Promise<Map<string, PaymentProof>> {
  const byOrder = new Map<string, string[]>();
  for (const j of journals) {
    if (j.source_type !== "order_payment" || !j.source_id) continue;
    const list = byOrder.get(j.source_id) ?? [];
    list.push(j.id);
    byOrder.set(j.source_id, list);
  }
  const proofs = new Map<string, PaymentProof>();
  if (byOrder.size === 0) return proofs;

  const { data } = await db
    .from("orders")
    .select(
      "id, payment_proof_url, customers!orders_customer_id_fkey(name)",
    )
    .in("id", [...byOrder.keys()])
    .not("payment_proof_url", "is", null);

  for (const o of (data ?? []) as unknown as {
    id: string;
    payment_proof_url: string;
    customers: { name: string | null } | null;
  }[]) {
    for (const journalId of byOrder.get(o.id) ?? [])
      proofs.set(journalId, {
        url: o.payment_proof_url,
        customer: o.customers?.name ?? null,
        orderId: o.id,
      });
  }
  return proofs;
}
