/**
 * The lifecycle an event enquiry moves through (migration 121).
 *
 * Its own module, with no server imports: the panel on /orders is a client
 * component, and pulling these names out of `leads.ts` would drag the
 * service-role Supabase client into the browser bundle.
 */
export const EVENT_LEAD_STATUSES = [
  "brief",
  "tendered",
  "quoted",
  "won",
  "lost",
] as const;

export type EventLeadStatus = (typeof EVENT_LEAD_STATUSES)[number];

/** A lead is still ours to chase until it is won or lost. */
export const OPEN_EVENT_LEAD_STATUSES: EventLeadStatus[] = [
  "brief",
  "tendered",
  "quoted",
];

export function isEventLeadStatus(v: unknown): v is EventLeadStatus {
  return (
    typeof v === "string" &&
    (EVENT_LEAD_STATUSES as readonly string[]).includes(v)
  );
}
