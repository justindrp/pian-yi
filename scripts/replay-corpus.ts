/**
 * Builds the replay corpus: real ordering conversations paired with the order
 * they actually produced. The order rows are the ground truth — what the bot
 * is supposed to reproduce when the same customer messages are played back at
 * it. Shared by replay-orders.ts and usable on its own to inspect a case.
 *
 *   tsx scripts/replay-corpus.ts [count]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

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
  expected: {
    packageSize: number;
    pricePerPortion: number;
    totalPrice: number;
    mealTimePreference: string | null;
    deliveryDates: string[];
  };
}

/** Messages this close together are one burst — the live webhook coalesces them. */
const BURST_GAP_MS = 90_000;

/** Media rows replay as their caption; a bare URL carries nothing the model can read. */
function replayableText(content: string, messageType: string | null): string | null {
  const text = String(content ?? "").trim();
  if (!text) return null;
  if (messageType === "image" || messageType === "document") {
    // A stored media row is either the caption (useful) or a bare storage URL.
    if (/^https?:\/\//.test(text)) return null;
    return text;
  }
  return text;
}

export async function buildCorpus(count = 20): Promise<CorpusCase[]> {
  const db = createAdminClient();

  const { data: orders } = await db
    .from("orders")
    .select("id, customer_id, package_size, price_per_portion, total_price, meal_time_preference, created_at, customers!orders_customer_id_fkey(name)")
    .eq("source", "purchase")
    .order("created_at", { ascending: false })
    .limit(count * 2);

  const cases: CorpusCase[] = [];
  for (const order of orders ?? []) {
    if (cases.length >= count) break;
    const createdAt = order.created_at ?? "";
    if (!createdAt) continue;

    // The ordering conversation: everything the customer said in the two weeks
    // before the order landed. Two weeks because a renewal often starts from a
    // thread that has been quiet, and anything older is a different order.
    const since = new Date(new Date(createdAt).getTime() - 14 * 86_400_000).toISOString();
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
      if (prev && new Date(at).getTime() - new Date(prev.at).getTime() < BURST_GAP_MS) {
        prev.text = `${prev.text}\n${text}`;
      } else {
        turns.push({ at, text });
      }
    }
    if (turns.length < 2) continue;

    const { data: dels } = await db
      .from("daily_deliveries")
      .select("delivery_date")
      .eq("order_id", order.id)
      .order("delivery_date");

    const c = order.customers as unknown as { name: string | null } | null;
    cases.push({
      orderId: order.id,
      customerId: order.customer_id ?? "",
      customerName: c?.name ?? null,
      createdAt,
      turns,
      expected: {
        packageSize: order.package_size,
        pricePerPortion: order.price_per_portion,
        totalPrice: order.total_price,
        mealTimePreference: order.meal_time_preference,
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
      `${c.createdAt.slice(0, 10)} ${c.orderId.slice(0, 8)} ${c.customerName ?? "?"} — ${c.turns.length} turns, pkg=${c.expected.packageSize} @${c.expected.pricePerPortion} ${c.expected.mealTimePreference ?? "-"} ${c.expected.deliveryDates.length} deliveries`,
    );
  }
  console.log(`\n${cases.length} cases`);
}

if (process.argv[1]?.endsWith("replay-corpus.ts")) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
