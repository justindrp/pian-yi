/**
 * How long ago the customer last wrote to us — the only thing that decides
 * whether we may send free-form text or must fall back to a template.
 *
 * The calculation was inline in three places (`assistant-tools.ts`,
 * `scripts/manual-send.ts`, and the forwarded-proof handler) before the
 * delivery-proof sender needed it as well; four copies of a 24 is where a
 * number starts drifting.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export const WINDOW_HOURS = 24;

/** Hours since the customer's last inbound message; Infinity if they never sent one. */
export async function hoursSinceInbound(customerId: string): Promise<number> {
  const db = createAdminClient();
  const { data } = await db
    .from("conversations")
    .select("created_at")
    .eq("customer_id", customerId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1);

  const at = data?.[0]?.created_at;
  return at
    ? (Date.now() - new Date(at).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;
}

export async function windowIsOpen(customerId: string): Promise<boolean> {
  return (await hoursSinceInbound(customerId)) < WINDOW_HOURS;
}
