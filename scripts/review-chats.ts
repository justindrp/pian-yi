/**
 * Prints whole customer threads for a chat review — the recurring "read the
 * last N chats / everything since X and tell me what needs a human" job.
 *
 *   pnpm review-chats                 # threads with inbound in the last 24h
 *   pnpm review-chats --since 6h      # ...in the last 6 hours
 *   pnpm review-chats --since 2026-09-11T06:30:00Z
 *   pnpm review-chats --last 2        # the 2 most recently active threads, window ignored
 *   pnpm review-chats --waiting       # threads a human still owes an answer, active in
 *                                    # the last 3 days (--days N to widen)
 *   pnpm review-chats --phone +62818755030
 *   pnpm review-chats --last 2 --messages 120   # deeper transcript (default 60)
 *
 * Every review before this one was a throwaway script written from scratch,
 * which is why each one selected threads differently and none of them printed
 * the flags that decide whether a thread is actually being answered. What a
 * review needs is fixed: who the customer is, their flags and state, their
 * orders, and the transcript in WIB with the author of every outbound line.
 *
 * Related: scripts/watch-thread.ts is a short one-shot dump of a single thread,
 * scripts/watch-inbound.ts tails one live. This is the batch read.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

type Args = {
  sinceIso: string | null;
  last: number | null;
  phone: string | null;
  waiting: boolean;
  days: number;
  messages: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sinceIso: null,
    last: null,
    phone: null,
    waiting: false,
    days: 3,
    messages: 60,
  };
  let since = "24h";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") since = argv[++i] ?? since;
    else if (a === "--last") args.last = Number(argv[++i]);
    else if (a === "--phone") args.phone = argv[++i] ?? null;
    else if (a === "--waiting") args.waiting = true;
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--messages") args.messages = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.last === null && args.phone === null && !args.waiting) {
    const hours = /^(\d+)h$/.exec(since);
    args.sinceIso = hours
      ? new Date(Date.now() - Number(hours[1]) * 3_600_000).toISOString()
      : new Date(since).toISOString();
  }
  return args;
}

function wib(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" });
}

/** Who wrote an outbound line: the model, a named admin, or the welcome/menu sender. */
function author(m: {
  role: string | null;
  model_used: string | null;
  sent_by: string | null;
}): string {
  if (m.role === "user") return "CUSTOMER";
  const bits = [m.model_used ?? "?", m.sent_by].filter(Boolean);
  return `US [${bits.join(" ")}]`;
}

/**
 * The customer ids to review, newest activity first. Paged rather than capped:
 * a 24h window on a busy day is more rows than one PostgREST page.
 */
async function selectThreads(
  db: ReturnType<typeof createAdminClient>,
  args: Args,
): Promise<string[]> {
  if (args.phone) {
    const { data, error } = await db
      .from("customers")
      .select("id")
      .eq("phone_number", args.phone)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`no customer ${args.phone}`);
    return [data.id];
  }

  // Every flag that means a person owes this thread an answer. They are not
  // interchangeable and only two of them reach the inbox's Unanswered filter,
  // which is how +6281212021234 sat nine hours on needs_human_review alone.
  if (args.waiting) {
    const { data, error } = await db
      .from("customer_flags")
      .select("customer_id")
      .or(
        "needs_human_review.eq.true,pending_bot_response.eq.true,escalated_to_human.eq.true",
      );
    if (error) throw new Error(error.message);
    const flagged = (data ?? [])
      .map((r) => r.customer_id)
      .filter((id): id is string => id !== null);
    if (flagged.length === 0) return [];

    // The flags are a dumping ground — 38 threads carry one, most of them
    // settled months ago and never cleared. What a review can act on is a
    // flagged thread that is still warm, newest first.
    const cutoff = new Date(Date.now() - args.days * 86_400_000).toISOString();
    const { data: threads, error: threadErr } = await db
      .from("inbox_threads")
      .select("customer_id, created_at")
      .in("customer_id", flagged)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false });
    if (threadErr) throw new Error(threadErr.message);
    return (threads ?? [])
      .map((r) => r.customer_id)
      .filter((id): id is string => id !== null);
  }

  if (args.last) {
    const { data, error } = await db
      .from("inbox_threads")
      .select("customer_id")
      .order("created_at", { ascending: false })
      .limit(args.last);
    if (error) throw new Error(error.message);
    return (data ?? [])
      .map((r) => r.customer_id)
      .filter((id): id is string => id !== null);
  }

  // Inbound only: an outbound re-ping is not a thread that needs reading, which
  // is why this cannot key off inbox_threads (last message whatever its role).
  //
  // review_inbound_threads (migration 119) is one row per customer with their
  // newest inbound, so "had an inbound since X" is a filter on that timestamp
  // and the distinct happens in Postgres. This used to page every inbound row
  // in the window 1000 at a time and dedupe here — O(messages) fetched to learn
  // O(customers), which is the wrong thing to grow with a busy day.
  const { data, error } = await db
    .from("review_inbound_threads")
    .select("customer_id")
    .gte("last_inbound_at", args.sinceIso as string)
    .order("last_inbound_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((r) => r.customer_id)
    .filter((id): id is string => id !== null);
}

/**
 * One thread's block, returned rather than printed: threads are fetched
 * concurrently, so writing to stdout from in here would interleave them.
 */
async function renderThread(
  db: ReturnType<typeof createAdminClient>,
  customerId: string,
  limit: number,
  kitchens: Map<string, string>,
): Promise<string> {
  const out: string[] = [];
  const say = (line = "") => out.push(line);

  const [{ data: cust }, { data: flags }, { data: state }, { data: orders }] =
    await Promise.all([
      db
        .from("customers")
        .select(
          "id, name, phone_number, area, sub_area, address, google_maps_link, subcontractor_id, kitchen_notes, contract_price_per_portion, notes",
        )
        .eq("id", customerId)
        .maybeSingle(),
      db
        .from("customer_flags")
        .select(
          "escalated_to_human, escalation_reason, pending_bot_response, pending_bot_question, needs_human_review, hold_until, last_human_activity_at",
        )
        .eq("customer_id", customerId)
        .maybeSingle(),
      db
        .from("customer_state")
        .select("state, menu_shown, reactivation_sent_at")
        .eq("customer_id", customerId)
        .maybeSingle(),
      db
        .from("orders")
        .select(
          "id, status, package_size, price_per_portion, total_price, start_date, confirmed_at, paid_at, subcontractor_id",
        )
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  say("=".repeat(78));
  say(
    `${cust?.name ?? "(no name)"}  ${cust?.phone_number ?? customerId}  ${cust?.area ?? "(no area)"}${
      cust?.subcontractor_id
        ? `  ${kitchens.get(cust.subcontractor_id) ?? cust.subcontractor_id}`
        : ""
    }`,
  );
  if (!cust?.google_maps_link) say("  no Maps link on file");
  if (cust?.contract_price_per_portion)
    say(`  contract rate Rp ${cust.contract_price_per_portion}`);
  if (cust?.kitchen_notes) say(`  kitchen_notes: ${cust.kitchen_notes}`);
  say(
    `  state: ${state?.state ?? "-"}  menu_shown: ${state?.menu_shown ?? "-"}`,
  );
  say(
    `  flags: escalated=${flags?.escalated_to_human ?? "-"} pending_bot=${flags?.pending_bot_response ?? "-"} needs_review=${flags?.needs_human_review ?? "-"}${
      flags?.hold_until ? ` hold_until=${wib(flags.hold_until)}` : ""
    }`,
  );
  if (flags?.escalation_reason)
    say(`  escalation_reason: ${flags.escalation_reason}`);
  if (flags?.pending_bot_question)
    say(`  pending question: ${flags.pending_bot_question}`);

  // Quota is counted from the delivery rows; the columns that claim to hold it
  // are dead. Booked is what exists, remaining is what is still to eat. One
  // query for every order on the thread, grouped here — a query per order was
  // five serial round-trips for a customer holding five packages.
  const byOrder = new Map<
    string,
    { delivery_date: string; portions: number | null }[]
  >();
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length > 0) {
    const { data: rows } = await db
      .from("daily_deliveries")
      .select("order_id, delivery_date, portions")
      .in("order_id", orderIds);
    for (const r of rows ?? []) {
      if (!r.order_id) continue;
      const list = byOrder.get(r.order_id);
      if (list) list.push(r);
      else byOrder.set(r.order_id, [r]);
    }
  }

  const today = wib(new Date().toISOString()).slice(0, 10);
  for (const o of orders ?? []) {
    const rows = byOrder.get(o.id) ?? [];
    // package_size is portions, so these must be portions too — a row may carry
    // several. Counting rows reported a 20-portion order as "booked 10".
    const booked = rows.reduce((n, r) => n + (r.portions ?? 0), 0);
    const delivered = rows
      .filter((r) => r.delivery_date <= today)
      .reduce((n, r) => n + (r.portions ?? 0), 0);
    say(
      `  order ${o.id.slice(0, 8)} ${o.status} ${o.package_size}p @${o.price_per_portion} start ${o.start_date ?? "-"}${
        o.paid_at ? ` paid ${wib(o.paid_at).slice(0, 16)}` : " UNPAID"
      }${o.subcontractor_id ? ` ${kitchens.get(o.subcontractor_id) ?? ""}` : ""} — booked ${booked}, delivered ${delivered}, unbooked ${o.package_size - booked}`,
    );
  }

  const { data: msgs } = await db
    .from("conversations")
    .select(
      "created_at, role, content, message_type, media_url, model_used, sent_by, whatsapp_status, whatsapp_error",
    )
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  say("-".repeat(78));
  for (const m of (msgs ?? []).reverse()) {
    const fail =
      m.whatsapp_status === "failed"
        ? ` FAILED ${JSON.stringify(m.whatsapp_error)}`
        : "";
    const media = m.media_url ? " (media)" : "";
    say(
      `${m.created_at ? wib(m.created_at) : "?"} ${author(m)}${fail} [${m.message_type}] ${m.content ?? ""}${media}`,
    );
  }
  say();
  return out.join("\n");
}

/** Threads do not depend on each other, so the only reason to wait for one
 *  before starting the next is to be polite to Postgres. A fixed pool keeps
 *  that politeness without serialising every round-trip. */
const CONCURRENCY = 6;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = createAdminClient();
  const ids = await selectThreads(db, args);
  console.log(
    args.sinceIso
      ? `${ids.length} thread(s) with inbound since ${wib(args.sinceIso)} WIB`
      : args.waiting
        ? `${ids.length} thread(s) flagged as owing someone an answer, active in the last ${args.days} day(s)`
        : `${ids.length} thread(s)`,
  );

  // Static reference data, fetched once: it was a round-trip per thread.
  const kitchens = new Map<string, string>();
  const { data: subs } = await db
    .from("subcontractors")
    .select("id, customer_nickname");
  for (const s of subs ?? []) kitchens.set(s.id, s.customer_nickname ?? s.id);

  // Rendered out of order, printed in order — a review is read top to bottom
  // and the newest-first ordering selectThreads chose is the whole point.
  const blocks = new Array<string>(ids.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      for (let i = next++; i < ids.length; i = next++) {
        blocks[i] = await renderThread(db, ids[i], args.messages, kitchens);
      }
    }),
  );
  for (const block of blocks) console.log(block);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
