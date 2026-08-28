/**
 * Drives scripted conversations through the live chatbot pipeline to check the
 * rule that `delivery_schedule` is required on every `extract_order` call.
 *
 *   rtk pnpm exec tsx --env-file=.env.local scripts/test-schedule-required.ts [--keep]
 *
 * Same safety rails as scripts/replay-orders.ts: every customer is a DEMO_
 * phone, which `src/lib/whatsapp/client.ts` refuses to hand to Meta, the clock
 * is pinned so "Senin depan" means something stable, and everything created is
 * deleted at the end.
 *
 * What it asserts:
 *  - a customer who never names days gets an order with no schedule and no
 *    delivery rows — never an invented week;
 *  - a customer who names days gets exactly those days on the order;
 *  - either way the bot never says the order is recorded without one existing.
 */
import { processWebhookAsync } from "../src/app/api/webhook/whatsapp/route";
import { createAdminClient } from "../src/lib/supabase/admin";
import { DEMO_PHONE_PREFIX, demoDisplayName } from "../src/lib/whatsapp/demo";
import type { WhatsAppWebhookPayload } from "../src/lib/whatsapp/types";

const RealDate = Date;
const NONCE = Math.random().toString(36).slice(2, 10).toUpperCase();

async function atTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const fixed = new RealDate(iso).getTime();
  class PinnedDate extends RealDate {
    // biome-ignore lint/suspicious/noExplicitAny: Date's overloads cannot be spread type-safely
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed);
      // biome-ignore lint/suspicious/noExplicitAny: same
      else super(...(args as [any]));
    }
    static now() {
      return fixed;
    }
  }
  (globalThis as { Date: DateConstructor }).Date =
    PinnedDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}

function payloadFor(
  phone: string,
  text: string,
  at: string,
  n: number,
): WhatsAppWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "SCHEDTEST",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "SCHEDTEST",
                phone_number_id: "SCHEDTEST",
              },
              messages: [
                {
                  id: `wamid.SCHED_${NONCE}_${phone}_${n}`,
                  from: phone,
                  type: "text",
                  timestamp: String(
                    Math.floor(new RealDate(at).getTime() / 1000),
                  ),
                  text: { body: text },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  } as WhatsAppWebhookPayload;
}

async function cleanupDemo(phone: string): Promise<void> {
  const db = createAdminClient();
  const { data: existing } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();
  if (!existing) return;
  const id = existing.id;
  await db.from("daily_deliveries").delete().eq("customer_id", id);
  await db.from("orders").delete().eq("customer_id", id);
  await db.from("conversations").delete().eq("customer_id", id);
  await db.from("customer_flags").delete().eq("customer_id", id);
  await db.from("customer_state").delete().eq("customer_id", id);
  await db.from("customer_rate_limits").delete().eq("customer_id", id);
  await db.from("customers").delete().eq("id", id);
}

/** The clock every turn runs under: a Jumat morning, well before the cutoff. */
const AT = "2026-08-28T03:00:00.000Z"; // 10:00 WIB

type Case = {
  key: string;
  what: string;
  turns: string[];
  /** null = the order must carry no schedule at all. */
  expectDates: string[] | null;
};

const CASES: Case[] = [
  {
    key: "bebas",
    what: "names no days — must not get a week invented for them",
    turns: [
      "Halo kak, saya mau pesan catering",
      "Nama saya Rian, mau 5 porsi dulu",
      "Alamatnya Cluster Allogio Timur 3 No.32, Gading Serpong",
      "Jadwalnya bebas aja kak, nanti saya kabari tiap mau kirim",
      "iya betul kak",
    ],
    expectDates: null,
  },
  {
    key: "named",
    what: "names Senin-Jumat — must get exactly those five days",
    turns: [
      "Halo kak mau pesan catering 5 porsi",
      "Nama saya Sinta, alamat Cluster Michelia Jl. Michelia 10 No 35, Gading Serpong",
      "Makan siang ya kak, Senin sampai Jumat mulai 31 Agustus",
      "iya",
    ],
    expectDates: [
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ],
  },
];

async function runCase(c: Case): Promise<boolean> {
  const db = createAdminClient();
  const phone = `+${DEMO_PHONE_PREFIX}SCHED${c.key.toUpperCase()}`;
  await cleanupDemo(phone);
  const { data: demo, error } = await db
    .from("customers")
    .insert({ phone_number: phone, name: demoDisplayName(phone) })
    .select("id")
    .single();
  if (error || !demo) throw new Error(`demo insert failed: ${error?.message}`);

  console.log(`\n=== ${c.key}: ${c.what}`);
  for (const [i, text] of c.turns.entries()) {
    const started = Date.now();
    await atTime(AT, () => processWebhookAsync(payloadFor(phone, text, AT, i)));
    console.log(
      `  · turn ${i + 1}/${c.turns.length} (${Math.round((Date.now() - started) / 1000)}s)`,
    );
  }

  const { data: orders } = await db
    .from("orders")
    .select("id, package_size, status, requested_schedule")
    .eq("customer_id", demo.id)
    .order("created_at", { ascending: false });
  const { data: rows } = await db
    .from("daily_deliveries")
    .select("delivery_date, meal_type")
    .eq("customer_id", demo.id)
    .order("delivery_date");
  const { data: convo } = await db
    .from("conversations")
    .select("role, content")
    .eq("customer_id", demo.id)
    .order("created_at");

  for (const m of convo ?? [])
    console.log(`  ${m.role === "user" ? ">" : "<"} ${m.content}`);

  const problems: string[] = [];
  const order = orders?.[0] ?? null;
  if ((orders?.length ?? 0) > 1)
    problems.push(`${orders?.length} orders created, expected 1`);
  if (!order) {
    problems.push("no order created");
  } else {
    const sched = (order.requested_schedule ?? null) as
      | { date: string; meal_type: string; portions: number }[]
      | null;
    const dates = sched?.map((s) => s.date) ?? null;
    if (c.expectDates === null) {
      if (dates && dates.length > 0)
        problems.push(`schedule invented: ${dates.join(", ")}`);
    } else {
      const want = c.expectDates.join(",");
      const got = (dates ?? []).join(",");
      if (want !== got) problems.push(`schedule ${got || "(none)"} ≠ ${want}`);
    }
  }
  // Rows are written at mark_paid, never before — an unpaid order holding rows
  // is food queued on a kitchen sheet for money nobody has sent.
  if ((rows?.length ?? 0) > 0)
    problems.push(
      `${rows?.length} delivery rows on an unpaid order: ${rows?.map((r) => r.delivery_date).join(", ")}`,
    );

  console.log(
    problems.length === 0
      ? `  PASS — order ${order?.package_size} porsi, schedule ${
          ((order?.requested_schedule as unknown[] | null)?.length ?? 0) ||
          "none"
        }`
      : `  FAIL — ${problems.join("; ")}`,
  );
  return problems.length === 0;
}

async function main() {
  const keep = process.argv.includes("--keep");
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const cases = only ? CASES.filter((c) => c.key === only) : CASES;
  let allOk = true;
  for (const c of cases) {
    const ok = await runCase(c).catch((e) => {
      console.log(`  THREW ${(e as Error).message}`);
      return false;
    });
    allOk &&= ok;
  }
  if (!keep)
    for (const c of cases)
      await cleanupDemo(`+${DEMO_PHONE_PREFIX}SCHED${c.key.toUpperCase()}`);
  console.log(`\n${allOk ? "ALL PASS" : "FAILURES"}`);
  process.exit(allOk ? 0 : 1);
}

main();
