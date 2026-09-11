/**
 * Prints whole customer threads for a chat review — the recurring "read the
 * last N chats / everything since X and tell me what needs a human" job.
 *
 *   pnpm review                 # threads with inbound in the last 24h
 *   pnpm review --since 6h      # ...in the last 6 hours
 *   pnpm review --since 2026-09-11T06:30:00Z
 *   pnpm review --last 2        # the 2 most recently active threads, window ignored
 *   pnpm review --waiting      # threads a human still owes an answer, active in
 *                              # the last 3 days (--days N to widen)
 *   pnpm review --phone +62818755030
 *   pnpm review --last 2 --messages 120   # deeper transcript (default 60)
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
    const cutoff = new Date(
      Date.now() - args.days * 86_400_000,
    ).toISOString();
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
    return (data ?? []).map((r) => r.customer_id).filter((id): id is string => id !== null);
  }

  // Inbound only: an outbound re-ping is not a thread that needs reading.
  const ids: string[] = [];
  const seen = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("conversations")
      .select("customer_id, created_at")
      .eq("role", "user")
      .gte("created_at", args.sinceIso as string)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      if (r.customer_id && !seen.has(r.customer_id)) {
        seen.add(r.customer_id);
        ids.push(r.customer_id);
      }
    }
    if ((data?.length ?? 0) < PAGE) break;
  }
  return ids;
}

async function printThread(
  db: ReturnType<typeof createAdminClient>,
  customerId: string,
  limit: number,
) {
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

  const kitchens = new Map<string, string>();
  const { data: subs } = await db
    .from("subcontractors")
    .select("id, customer_nickname");
  for (const s of subs ?? []) kitchens.set(s.id, s.customer_nickname ?? s.id);

  console.log("=".repeat(78));
  console.log(
    `${cust?.name ?? "(no name)"}  ${cust?.phone_number ?? customerId}  ${cust?.area ?? "(no area)"}${
      cust?.subcontractor_id
        ? `  ${kitchens.get(cust.subcontractor_id) ?? cust.subcontractor_id}`
        : ""
    }`,
  );
  if (!cust?.google_maps_link) console.log("  no Maps link on file");
  if (cust?.contract_price_per_portion)
    console.log(`  contract rate Rp ${cust.contract_price_per_portion}`);
  if (cust?.kitchen_notes) console.log(`  kitchen_notes: ${cust.kitchen_notes}`);
  console.log(
    `  state: ${state?.state ?? "-"}  menu_shown: ${state?.menu_shown ?? "-"}`,
  );
  console.log(
    `  flags: escalated=${flags?.escalated_to_human ?? "-"} pending_bot=${flags?.pending_bot_response ?? "-"} needs_review=${flags?.needs_human_review ?? "-"}${
      flags?.hold_until ? ` hold_until=${wib(flags.hold_until)}` : ""
    }`,
  );
  if (flags?.escalation_reason)
    console.log(`  escalation_reason: ${flags.escalation_reason}`);
  if (flags?.pending_bot_question)
    console.log(`  pending question: ${flags.pending_bot_question}`);

  for (const o of orders ?? []) {
    // Quota is counted from the delivery rows; the columns that claim to hold
    // it are dead. Booked is what exists, remaining is what is still to eat.
    const { data: rows } = await db
      .from("daily_deliveries")
      .select("delivery_date")
      .eq("order_id", o.id);
    const today = wib(new Date().toISOString()).slice(0, 10);
    const booked = rows?.length ?? 0;
    const delivered = (rows ?? []).filter((r) => r.delivery_date <= today).length;
    console.log(
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

  console.log("-".repeat(78));
  for (const m of (msgs ?? []).reverse()) {
    const fail =
      m.whatsapp_status === "failed"
        ? ` FAILED ${JSON.stringify(m.whatsapp_error)}`
        : "";
    const media = m.media_url ? " (media)" : "";
    console.log(
      `${m.created_at ? wib(m.created_at) : "?"} ${author(m)}${fail} [${m.message_type}] ${m.content ?? ""}${media}`,
    );
  }
  console.log();
}

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
  for (const id of ids) await printThread(db, id, args.messages);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
