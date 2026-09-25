import { OPEN_EVENT_LEAD_STATUSES } from "@/lib/events/lead-status";
import { createAdminClient } from "@/lib/supabase/admin";

type UpsertInput = {
  customerId: string;
  eventDate: string | null;
  portions: number | null;
  venue: string | null;
  brief: string | null;
};

/**
 * The customer's open event lead, if they have one.
 *
 * Whether a thread is an event cannot be read off the order's shape alone:
 * Natalie's crew event on 2026-09-25 was 27 portions a day for five days, which
 * looks exactly like a subscription, and `extract_order` priced it off Dapur
 * Suplir's ladder and sent the bank details for Rp 2.340.000 against an agreed
 * Rp 3.645.000. The lead is what knows.
 */
export async function openEventLead(
  customerId: string,
): Promise<{ id: string; status: string; quoted: number | null } | null> {
  const db = createAdminClient();
  const { data } = await db
    .from("event_leads")
    .select("id, status, quoted_price_per_portion")
    .eq("customer_id", customerId)
    .in("status", OPEN_EVENT_LEAD_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);
  const lead = (data ?? [])[0];
  return lead
    ? {
        id: lead.id,
        status: lead.status,
        quoted: lead.quoted_price_per_portion,
      }
    : null;
}

/**
 * Record an event enquiry, or fill in what a second message added to one.
 *
 * Matched on the customer's open lead rather than inserted blind: a customer
 * refines a brief over several messages — 20 porsi becomes 25, the date moves a
 * day — and each of those is the same event, not a new one. An open lead with
 * no date at all is treated as the same event too, because "belum tahu
 * tanggalnya" is how most briefs start. A won or lost lead is never reopened:
 * the next enquiry from that customer is a different event.
 *
 * Only fills fields it has. A model that omits the address on the follow-up
 * call must not erase the venue the first call captured.
 */
export async function upsertEventLead(input: UpsertInput): Promise<void> {
  const db = createAdminClient();

  const { data: open } = await db
    .from("event_leads")
    .select("id, event_date, portions, venue, brief")
    .eq("customer_id", input.customerId)
    .in("status", OPEN_EVENT_LEAD_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);

  const existing = (open ?? [])[0];
  const sameEvent =
    existing &&
    (existing.event_date === null ||
      input.eventDate === null ||
      existing.event_date === input.eventDate);

  if (existing && sameEvent) {
    await db
      .from("event_leads")
      .update({
        event_date: input.eventDate ?? existing.event_date,
        portions: input.portions ?? existing.portions,
        venue: input.venue ?? existing.venue,
        brief: input.brief ?? existing.brief,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return;
  }

  await db.from("event_leads").insert({
    customer_id: input.customerId,
    event_date: input.eventDate,
    portions: input.portions,
    venue: input.venue,
    brief: input.brief,
    status: "brief",
  });
}
