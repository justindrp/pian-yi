/**
 * Builds the replay corpus: real ordering conversations paired with the order
 * they actually produced. The order rows are the ground truth — what the bot
 * is supposed to reproduce when the same customer messages are played back at
 * it. Shared by replay-orders.ts and usable on its own to inspect a case.
 *
 *   tsx scripts/replay-corpus.ts [count]
 */

import { createAdminClient } from "../src/lib/supabase/admin";
import { isDemoPhone } from "../src/lib/whatsapp/demo";

export interface CorpusTurn {
  /** Original timestamp — the replay pins "today" to this so relative dates hold. */
  at: string;
  text: string;
}

export interface CorpusCase {
  orderId: string;
  customerId: string;
  customerName: string | null;
  createdAt: string;
  turns: CorpusTurn[];
  expected: CorpusExpectation;
  /**
   * The other orders the same conversation produced. Tiwi's 2026-08-03 thread
   * bought 5 porsi and then 6, so it entered the corpus twice with different
   * ground truth while one replay run creates one order — at most one of the
   * two could ever pass. A run that reproduces any order the conversation
   * really produced has reproduced it.
   */
  alternatives: CorpusExpectation[];
}

export interface CorpusExpectation {
  packageSize: number;
  pricePerPortion: number;
  totalPrice: number;
  deliveryDates: string[];
}

/** Messages this close together are one burst — the live webhook coalesces them. */
const BURST_GAP_MS = 90_000;

/** Media rows replay as their caption; a bare URL carries nothing the model can read. */
function replayableText(
  content: string,
  messageType: string | null,
): string | null {
  const text = String(content ?? "").trim();
  if (!text) return null;
  if (messageType === "image" || messageType === "document") {
    // A stored media row is either the caption (useful) or a bare storage URL.
    if (/^https?:\/\//.test(text)) return null;
    return text;
  }
  return text;
}

/** A customer turn that could carry the package size: portions, days, weeks or money. */
const SIZE_EVIDENCE =
  /(?<![\d.,])\d+\s*(porsi|hari|minggu|bulan|pax|orang)|rp\.?\s*\d|\d{1,3}(\.\d{3})+/i;

export async function buildCorpus(count = 20): Promise<CorpusCase[]> {
  const db = createAdminClient();

  const { data: orders } = await db
    .from("orders")
    .select(
      "id, customer_id, package_size, price_per_portion, total_price, created_at, customers!orders_customer_id_fkey(name, phone_number)",
    )
    .eq("source", "purchase")
    // A cancelled order is not something the bot should reproduce. The phantom
    // order recovery built for Nadya on 2026-08-19 landed in the corpus as
    // ground truth, so the harness was asking the bot to rebuild a bug.
    .not(
      "status",
      "in",
      "(cancelled_unpaid,cancelled_by_customer,cancelled_by_admin,refunded)",
    )
    .order("created_at", { ascending: false })
    .limit(count * 2);

  const cases: CorpusCase[] = [];
  // An order already folded into an earlier case as an alternative must not
  // become a case of its own.
  const covered = new Set<string>();
  for (const order of orders ?? []) {
    if (cases.length >= count) break;
    if (covered.has(order.id)) continue;
    // Never build ground truth out of the harness's own output. Demo rows live
    // only for the length of a case, but a corpus rebuilt while a round is in
    // flight sees them — and an order the bot just wrote is the one thing that
    // can never be evidence of what the bot should write.
    if (
      isDemoPhone(
        (order.customers as unknown as { phone_number?: string } | null)
          ?.phone_number,
      )
    )
      continue;
    const createdAt = order.created_at ?? "";
    if (!createdAt) continue;

    // The ordering conversation: everything the customer said in the two weeks
    // before the order landed. Two weeks because a renewal often starts from a
    // thread that has been quiet, and anything older is a different order.
    const since = new Date(
      new Date(createdAt).getTime() - 14 * 86_400_000,
    ).toISOString();
    const { data: msgs } = await db
      .from("conversations")
      .select("created_at, role, content, message_type")
      .eq("customer_id", order.customer_id ?? "")
      .eq("role", "user")
      .gte("created_at", since)
      .lte("created_at", createdAt)
      .order("created_at", { ascending: true });

    const turns: CorpusTurn[] = [];
    for (const m of msgs ?? []) {
      const text = replayableText(String(m.content), m.message_type);
      if (!text) continue;
      const at = m.created_at ?? createdAt;
      const prev = turns[turns.length - 1];
      if (
        prev &&
        new Date(at).getTime() - new Date(prev.at).getTime() < BURST_GAP_MS
      ) {
        prev.text = `${prev.text}\n${text}`;
      } else {
        turns.push({ at, text });
      }
    }
    if (turns.length < 2) continue;

    // An order whose size the customer never stated in words is not something
    // the bot can reproduce: the model never sees images, so a package agreed
    // from a filled order form sent as a photo is unknowable to it. Nadya's
    // 2026-07 order sat behind a window whose every customer message was about
    // schedule changes ("tanpa nasi", "ganti siang") — scoring it asks the bot
    // to invent 20 porsi. Keeping the corpus honest matters more than its size.
    if (!turns.some((t) => SIZE_EVIDENCE.test(t.text))) continue;

    const { data: dels } = await db
      .from("daily_deliveries")
      .select("delivery_date")
      .eq("order_id", order.id)
      .order("delivery_date");

    // Orders the same customer placed out of this same window of conversation.
    // The window is the messages we just replayed, so anything bought inside it
    // came from the turns the bot is being scored on.
    const windowStart = turns[0]?.at ?? since;
    const { data: siblings } = await db
      .from("orders")
      .select(
        "id, package_size, price_per_portion, total_price, created_at",
      )
      .eq("customer_id", order.customer_id ?? "")
      .eq("source", "purchase")
      .not(
        "status",
        "in",
        "(cancelled_unpaid,cancelled_by_customer,cancelled_by_admin,refunded)",
      )
      .gte("created_at", windowStart)
      .neq("id", order.id);
    const alternatives: CorpusExpectation[] = [];
    for (const sib of siblings ?? []) {
      if (sib.created_at && sib.created_at > createdAt) {
        // Only fold in siblings from this window, not the customer's future.
        if (
          new Date(sib.created_at).getTime() - new Date(createdAt).getTime() >
          86_400_000
        )
          continue;
      }
      covered.add(sib.id);
      const { data: sibDels } = await db
        .from("daily_deliveries")
        .select("delivery_date")
        .eq("order_id", sib.id)
        .order("delivery_date");
      alternatives.push({
        packageSize: sib.package_size,
        pricePerPortion: sib.price_per_portion,
        totalPrice: sib.total_price,
        deliveryDates: (sibDels ?? []).map((d) => d.delivery_date),
      });
    }

    const c = order.customers as unknown as { name: string | null } | null;
    cases.push({
      alternatives,
      orderId: order.id,
      customerId: order.customer_id ?? "",
      customerName: c?.name ?? null,
      createdAt,
      turns,
      expected: {
        packageSize: order.package_size,
        pricePerPortion: order.price_per_portion,
        totalPrice: order.total_price,
        deliveryDates: (dels ?? []).map((d) => d.delivery_date),
      },
    });
  }
  return cases;
}

async function main() {
  const cases = await buildCorpus(Number(process.argv[2] ?? 20));
  for (const c of cases) {
    console.log(
      `${c.createdAt.slice(0, 10)} ${c.orderId.slice(0, 8)} ${c.customerName ?? "?"} — ${c.turns.length} turns, pkg=${c.expected.packageSize} @${c.expected.pricePerPortion} ${c.expected.deliveryDates.length} deliveries`,
    );
  }
  console.log(`\n${cases.length} cases`);
}

if (process.argv[1]?.endsWith("replay-corpus.ts")) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
