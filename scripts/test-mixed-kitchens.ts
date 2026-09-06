/**
 * Drives a scripted conversation through the live chatbot pipeline to check
 * that one package can be split across dapur.
 *
 *   rtk pnpm exec tsx --env-file=.env.local scripts/test-mixed-kitchens.ts [--keep]
 *
 * Same rails as scripts/test-schedule-required.ts: a DEMO_ phone, which
 * `src/lib/whatsapp/client.ts` refuses to hand to Meta, a pinned clock, and
 * everything created deleted at the end.
 *
 * What it asserts:
 *  - a customer who asks for two dapur in one week gets ONE order, not two;
 *  - the days they asked another dapur for carry that dapur and its own rate on
 *    `orders.requested_schedule`, and the rest stay bare;
 *  - `total_price` is the sum of the days, not one rate times the porsi;
 *  - the rows mark_paid would write name the right kitchen per day.
 */
import { buildPaidDeliveryRows } from "../src/lib/orders/paid-delivery-rows";
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
        id: "MIXTEST",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "MIXTEST",
                phone_number_id: "MIXTEST",
              },
              messages: [
                {
                  id: `wamid.MIX_${NONCE}_${phone}_${n}`,
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

function phoneFor(key: string): string {
  return `+${DEMO_PHONE_PREFIX}MIX${key.toUpperCase()}${NONCE}`;
}

const DEMO_PHONE_LIKE = `+${DEMO_PHONE_PREFIX}MIX%`;

async function cleanupCustomer(id: string): Promise<void> {
  const db = createAdminClient();
  await db.from("daily_deliveries").delete().eq("customer_id", id);
  await db.from("orders").delete().eq("customer_id", id);
  await db.from("conversations").delete().eq("customer_id", id);
  await db.from("customer_flags").delete().eq("customer_id", id);
  await db.from("customer_state").delete().eq("customer_id", id);
  await db.from("customer_rate_limits").delete().eq("customer_id", id);
  await db.from("customers").delete().eq("id", id);
}

async function sweepStaleDemos(): Promise<void> {
  const db = createAdminClient();
  const cutoff = new RealDate(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: stale } = await db
    .from("customers")
    .select("id, phone_number")
    .like("phone_number", DEMO_PHONE_LIKE)
    .lt("created_at", cutoff);
  for (const row of stale ?? []) {
    console.log(`  (sweeping stale demo ${row.phone_number})`);
    await cleanupCustomer(row.id);
  }
}

/** Jumat morning, well before the 16:00 cutoff. */
const AT = "2026-09-04T03:00:00.000Z";

type StoredSlot = {
  date: string;
  meal_type: string;
  portions: number;
  subcontractor_id?: string;
  price_per_portion?: number;
};

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const db = createAdminClient();
  await sweepStaleDemos();

  const { data: kitchens } = await db
    .from("subcontractors")
    .select("id, customer_nickname, delivery_days")
    .eq("is_active", true)
    .not("customer_nickname", "is", null);
  const nameOf = new Map(
    (kitchens ?? []).map((k) => [k.id, k.customer_nickname as string]),
  );
  console.log(
    `Active dapur: ${[...nameOf.values()].join(", ")}\n`,
  );

  const phone = phoneFor("split");
  const { data: demo, error } = await db
    .from("customers")
    .insert({ phone_number: phone, name: demoDisplayName(phone) })
    .select("id")
    .single();
  if (error || !demo) throw new Error(`demo insert failed: ${error?.message}`);

  const nicknames = [...nameOf.values()];
  const turns = [
    "Halo kak, saya mau pesan catering",
    "Nama saya Vero, alamat Cluster Sutera Onyx No 12, Alam Sutera. Maps: https://maps.app.goo.gl/testmixlink",
    `Mau 5 porsi makan malam, Senin sampai Jumat mulai 7 September. Tapi boleh nggak kalau hari Kamis sama Jumat saya coba ${nicknames[1] ?? "dapur lain"}, sisanya ${nicknames[0]}?`,
    "iya betul kak, tolong diproses",
  ];

  for (const [i, text] of turns.entries()) {
    const started = Date.now();
    await atTime(AT, () => processWebhookAsync(payloadFor(phone, text, AT, i)));
    console.log(
      `  · turn ${i + 1}/${turns.length} (${Math.round((Date.now() - started) / 1000)}s)`,
    );
  }

  const { data: convo } = await db
    .from("conversations")
    .select("role, content")
    .eq("customer_id", demo.id)
    .order("created_at");
  for (const m of convo ?? [])
    console.log(`  ${m.role === "user" ? ">" : "<"} ${m.content}`);

  const { data: orders } = await db
    .from("orders")
    .select(
      "id, package_size, price_per_portion, total_price, subcontractor_id, requested_schedule, customer_id, lunch_address_slot, dinner_address_slot",
    )
    .eq("customer_id", demo.id)
    .order("created_at", { ascending: false });

  const problems: string[] = [];
  const order = orders?.[0] ?? null;
  if ((orders?.length ?? 0) > 1)
    problems.push(`${orders?.length} orders created, expected 1`);

  if (!order) {
    problems.push("no order created");
  } else {
    const sched = (order.requested_schedule ?? []) as StoredSlot[];
    const away = sched.filter((s) => s.subcontractor_id);
    console.log(`\n  order ${order.package_size} porsi`);
    console.log(`  dapur: ${nameOf.get(order.subcontractor_id ?? "") ?? "—"}`);
    console.log(`  price_per_portion ${order.price_per_portion}`);
    console.log(`  total_price ${order.total_price}`);
    for (const s of sched)
      console.log(
        `    ${s.date} ${s.meal_type} ${s.portions}p ${
          s.subcontractor_id
            ? `${nameOf.get(s.subcontractor_id) ?? s.subcontractor_id} @ ${s.price_per_portion}`
            : "(dapur pesanan)"
        }`,
      );

    if (away.length === 0)
      problems.push("no day carries a second dapur — the split was not written");
    if (away.some((s) => !s.price_per_portion))
      problems.push("an away day carries a dapur but no rate");

    const expected = sched.reduce(
      (sum, s) =>
        sum + s.portions * (s.price_per_portion ?? order.price_per_portion),
      0,
    );
    if (away.length > 0 && order.total_price !== expected)
      problems.push(`total_price ${order.total_price} ≠ sum of days ${expected}`);

    const rows = await buildPaidDeliveryRows({
      db,
      order: {
        id: order.id,
        customer_id: order.customer_id,
        package_size: order.package_size,
        subcontractor_id: order.subcontractor_id,
        lunch_address_slot: order.lunch_address_slot,
        dinner_address_slot: order.dinner_address_slot,
      },
      customerSubcontractorId: order.subcontractor_id,
      requested: sched,
    });
    console.log("\n  rows mark_paid would write:");
    for (const r of rows)
      console.log(
        `    ${r.delivery_date} ${r.meal_type} ${r.portions}p → ${
          nameOf.get(r.subcontractor_id ?? "") ?? "—"
        }${r.price_per_portion ? ` @ ${r.price_per_portion}` : ""}`,
      );
    const awayDates = new Set(away.map((s) => s.date));
    for (const r of rows) {
      const wanted = sched.find(
        (s) => s.date === r.delivery_date && s.meal_type === r.meal_type,
      );
      const wantKitchen = wanted?.subcontractor_id ?? order.subcontractor_id;
      if (r.subcontractor_id !== wantKitchen)
        problems.push(
          `${r.delivery_date} cooked by the wrong dapur: ${r.subcontractor_id} ≠ ${wantKitchen}`,
        );
      if (awayDates.has(r.delivery_date) && !r.price_per_portion)
        problems.push(`${r.delivery_date} is an away day with no rate on the row`);
    }
  }

  console.log(
    problems.length === 0
      ? "\n  PASS"
      : `\n  FAIL\n${problems.map((p) => `    - ${p}`).join("\n")}`,
  );

  if (!keep) await cleanupCustomer(demo.id);
  else console.log(`  (kept ${phone})`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
