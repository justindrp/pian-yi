/**
 * Prints the lead pipeline — everyone who talked to us recently and has not
 * bought, plus every open `event_leads` row.
 *
 *   pnpm review-leads            # last 3 days
 *   pnpm review-leads --days 7
 *   pnpm review-leads --days 7 --transcripts   # whole thread per lead
 *
 * A "lead" here is a customer with inbound chat in the window and no order
 * that has ever been paid. Someone with a `pending_payment` order is still a
 * lead — the money has not arrived — and is marked as such.
 *
 * Every read walks with fetchAllRows: `query_leads` once returned only the
 * oldest conversations and made its newest leads look unreachable.
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { fetchAllRows } from "../src/lib/supabase/fetch-all";

const DAYS = (() => {
  const i = process.argv.indexOf("--days");
  return i >= 0 ? Number(process.argv[i + 1]) : 3;
})();

// Why a lead went quiet is only readable in the whole thread — the first and
// last line alone cannot tell a price objection from an unanswered question.
const TRANSCRIPTS = process.argv.includes("--transcripts");

const wib = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const hoursSince = (iso: string) =>
  (Date.now() - new Date(iso).getTime()) / 3_600_000;

type Msg = {
  customer_id: string | null;
  role: string;
  content: string | null;
  message_type: string | null;
  model_used: string | null;
  created_at: string | null;
};

type Dated = Omit<Msg, "customer_id" | "created_at"> & {
  customer_id: string;
  created_at: string;
};

async function main() {
  const db = createAdminClient();
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

  const { rows: rawMsgs, error: mErr } = await fetchAllRows<Msg>((from, to) =>
    db
      .from("conversations")
      .select("customer_id, role, content, message_type, model_used, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, to),
  );
  if (mErr) throw new Error(mErr);

  // `customer_id` and `created_at` are nullable in the schema; a message with
  // neither belongs to no thread and cannot be placed on the clock.
  const msgs = rawMsgs.filter(
    (m): m is Dated => m.customer_id !== null && m.created_at !== null,
  );

  // Customers with at least one INBOUND message in the window.
  const active = new Set(
    msgs.filter((m) => m.role === "user").map((m) => m.customer_id),
  );
  if (active.size === 0) {
    console.log(`No inbound chat in the last ${DAYS} days.`);
    return;
  }
  const ids = [...active];

  const { rows: customers, error: cErr } = await fetchAllRows<{
    id: string;
    name: string | null;
    phone_number: string;
    area: string | null;
    sub_area: string | null;
    google_maps_link: string | null;
    subcontractor_id: string | null;
    created_at: string | null;
  }>((from, to) =>
    db
      .from("customers")
      .select(
        "id, name, phone_number, area, sub_area, google_maps_link, subcontractor_id, created_at",
      )
      .in("id", ids)
      .range(from, to),
  );
  if (cErr) throw new Error(cErr);

  const { rows: orders, error: oErr } = await fetchAllRows<{
    id: string;
    customer_id: string | null;
    status: string;
    package_size: number;
    total_price: number;
    paid_at: string | null;
    start_date: string;
    created_at: string | null;
    source: string;
  }>((from, to) =>
    db
      .from("orders")
      .select(
        "id, customer_id, status, package_size, total_price, paid_at, start_date, created_at, source",
      )
      .in("customer_id", ids)
      .order("created_at", { ascending: false })
      .range(from, to),
  );
  if (oErr) throw new Error(oErr);

  const { rows: kitchens } = await fetchAllRows<{
    id: string;
    customer_nickname: string | null;
  }>((from, to) =>
    db.from("subcontractors").select("id, customer_nickname").range(from, to),
  );
  const kitchenName = new Map(kitchens.map((k) => [k.id, k.customer_nickname]));

  const byCustomer = new Map<string, Dated[]>();
  for (const m of msgs) {
    const list = byCustomer.get(m.customer_id) ?? [];
    list.push(m);
    byCustomer.set(m.customer_id, list);
  }
  const ordersBy = new Map<string, typeof orders>();
  for (const o of orders) {
    if (o.customer_id === null) continue;
    const list = ordersBy.get(o.customer_id) ?? [];
    list.push(o);
    ordersBy.set(o.customer_id, list);
  }

  type Row = {
    c: (typeof customers)[number];
    thread: Dated[];
    orders: typeof orders;
    lastInbound: Dated;
    lastMsg: Dated;
    everPaid: boolean;
    pending: typeof orders;
  };

  const rows: Row[] = [];
  for (const c of customers) {
    const thread = byCustomer.get(c.id) ?? [];
    const inbound = thread.filter((m) => m.role === "user");
    if (inbound.length === 0) continue;
    const os = ordersBy.get(c.id) ?? [];
    rows.push({
      c,
      thread,
      orders: os,
      lastInbound: inbound[inbound.length - 1],
      lastMsg: thread[thread.length - 1],
      everPaid: os.some((o) => o.paid_at !== null),
      pending: os.filter((o) => o.status === "pending_payment"),
    });
  }

  const leads = rows.filter((r) => !r.everPaid);
  leads.sort(
    (a, b) => +new Date(b.lastInbound.created_at) - +new Date(a.lastInbound.created_at),
  );

  console.log(
    `\n${leads.length} lead(s) — inbound in the last ${DAYS} days, never paid. ` +
      `(${rows.length - leads.length} existing paying customers also active, not listed.)\n`,
  );

  for (const r of leads) {
    const h = hoursSince(r.lastInbound.created_at);
    const window = h < 24 ? `OPEN ${(24 - h).toFixed(1)}h left` : "SHUT";
    const waiting = r.lastMsg.role === "user" ? "  ⟵ WAITING ON US" : "";
    const first = r.thread[0];
    const isNew =
      r.c.created_at != null && +new Date(r.c.created_at) >= +new Date(since);

    console.log("─".repeat(78));
    console.log(
      `${r.c.name ?? "(no name)"}  ${r.c.phone_number}${isNew ? "  [NEW]" : ""}`,
    );
    console.log(
      `  area: ${r.c.area ?? "—"}${r.c.sub_area ? ` / ${r.c.sub_area}` : ""}` +
        `   maps: ${r.c.google_maps_link ? "yes" : "NO"}` +
        `   dapur: ${r.c.subcontractor_id ? (kitchenName.get(r.c.subcontractor_id) ?? "?") : "—"}`,
    );
    console.log(
      `  window: ${window}   msgs in window: ${r.thread.length}` +
        `   last inbound: ${wib(r.lastInbound.created_at)}${waiting}`,
    );
    if (r.orders.length) {
      for (const o of r.orders) {
        console.log(
          `  order ${o.id.slice(0, 8)}  ${o.status}  ${o.package_size ?? "?"}p  ` +
            `Rp ${(o.total_price ?? 0).toLocaleString("id-ID")}  ` +
            `start ${o.start_date}  made ${o.created_at ? wib(o.created_at) : "—"}` +
            (o.source && o.source !== "purchase" ? `  [${o.source}]` : ""),
        );
      }
    } else {
      console.log("  orders: none");
    }
    if (TRANSCRIPTS) {
      for (const m of r.thread) {
        console.log(
          `  ${wib(m.created_at)} ${who(m).toUpperCase().padEnd(9)}${excerpt(m, 400)}`,
        );
      }
    } else {
      console.log(`  first in window (${wib(first.created_at)}): ${excerpt(first)}`);
      console.log(`  last  (${wib(r.lastMsg.created_at)}, ${who(r.lastMsg)}): ${excerpt(r.lastMsg)}`);
    }
  }

  // Event leads — their own table, brief through won/lost.
  const { rows: evs } = await fetchAllRows<{
    id: string;
    customer_id: string;
    event_date: string | null;
    portions: number | null;
    venue: string | null;
    brief: string | null;
    status: string;
    quoted_price_per_portion: number | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
  }>((from, to) =>
    db
      .from("event_leads")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  console.log(`\n${"═".repeat(78)}\nEVENT LEADS (event_leads table) — ${evs.length} total\n`);
  const evCustIds = [...new Set(evs.map((e) => e.customer_id))];
  const { rows: evCusts } = evCustIds.length
    ? await fetchAllRows<{ id: string; name: string | null; phone_number: string }>(
        (from, to) =>
          db
            .from("customers")
            .select("id, name, phone_number")
            .in("id", evCustIds)
            .range(from, to),
      )
    : { rows: [] as { id: string; name: string | null; phone_number: string }[] };
  const evName = new Map(evCusts.map((c) => [c.id, `${c.name ?? "(no name)"} ${c.phone_number}`]));

  for (const e of evs) {
    const open = e.status !== "won" && e.status !== "lost";
    const dLeft =
      e.event_date != null
        ? Math.round(
            (+new Date(`${e.event_date}T00:00:00+07:00`) - Date.now()) / 86_400_000,
          )
        : null;
    console.log(
      `${open ? "●" : "○"} ${e.status.toUpperCase().padEnd(9)} ${evName.get(e.customer_id) ?? e.customer_id}`,
    );
    console.log(
      `    ${e.portions ?? "?"} porsi   ${e.event_date ?? "no date"}` +
        (dLeft != null ? ` (H${dLeft >= 0 ? "-" : "+"}${Math.abs(dLeft)})` : "") +
        `   venue: ${e.venue ?? "—"}` +
        (e.quoted_price_per_portion ? `   quoted Rp ${e.quoted_price_per_portion.toLocaleString("id-ID")}/porsi` : "   not quoted"),
    );
    if (e.brief) console.log(`    brief: ${e.brief.slice(0, 160)}`);
    if (e.notes) console.log(`    notes: ${e.notes.slice(0, 160)}`);
    console.log(`    opened ${wib(e.created_at)}   updated ${wib(e.updated_at)}`);
  }
  console.log();
}

function who(m: Dated): string {
  if (m.role === "user") return "customer";
  if (m.model_used === "human") return "admin";
  if (m.model_used === "system") return "system";
  return "bot";
}

function excerpt(m: Dated, max = 180): string {
  const t = (m.content ?? "").replace(/\s+/g, " ").trim();
  const tag = m.message_type && m.message_type !== "text" ? `[${m.message_type}] ` : "";
  return tag + (t.length > max ? `${t.slice(0, max)}…` : t || "(empty)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
