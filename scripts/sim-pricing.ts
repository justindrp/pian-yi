#!/usr/bin/env tsx
/**
 * Sends real messages to the chatbot and checks the prices it quotes.
 *
 * Migration 098 keyed `pricing_tiers` by kitchen, and every read of the table
 * moved behind `tiersForKitchen()` / `.is("subcontractor_id", null)`. A read
 * that forgets the kitchen still returns rows — the wrong kitchen's — so a
 * broken scope does not throw, it quotes. Unit tests mock the table away, so
 * the only way to see the scope working is to ask the live bot for a price and
 * read what it says.
 *
 *   tsx scripts/sim-pricing.ts              # every case
 *   tsx scripts/sim-pricing.ts --only=15    # one case by id prefix
 *   tsx scripts/sim-pricing.ts --keep       # leave the demo rows behind
 *
 * Safe against production: every case talks to a `DEMO_` phone, which
 * `src/lib/whatsapp/client.ts` refuses to hand to Meta on every send path, and
 * each case's customer and everything it created is deleted at the end.
 */
import { processWebhookAsync } from "../src/app/api/webhook/whatsapp/route";
import { createAdminClient } from "../src/lib/supabase/admin";
import { DEMO_PHONE_PREFIX, demoDisplayName } from "../src/lib/whatsapp/demo";
import type { WhatsAppWebhookPayload } from "../src/lib/whatsapp/types";

const RUN_NONCE = Math.random().toString(36).slice(2, 10).toUpperCase();

interface Case {
  id: string;
  what: string;
  /** Seeded onto the demo customer, for the cases that get as far as an order. */
  seed?: { address?: string; area?: string; google_maps_link?: string };
  turns: string[];
  /** Every one of these must appear somewhere in the bot's replies. */
  expect: (string | RegExp)[];
  /** None of these may appear. */
  reject?: (string | RegExp)[];
  /** Checked against the order the case created, when it is meant to create one. */
  expectOrder?: { package_size: number; price_per_portion: number };
}

// The house ladder is 5/6 → 29.000, 10/12 → 28.000, 20/24 → 27.000,
// 40-72 → 26.000, 120/144 → 25.000. Every figure below is that ladder read
// through the rule the prompt states, so a wrongly-scoped read shows up as a
// Santapin (29.500) or Homey (44.000) number instead.
const CASES: Case[] = [
  {
    id: "5-porsi",
    what: "the smallest package, quoted off the bottom of the ladder",
    turns: ["halo kak", "1 porsi siang aja senin sampai jumat berapa ya?"],
    expect: [/145\.?000/, /29\.?000/],
    reject: [/\b30\.?500\b/, /\b45\.?000\b/],
  },
  {
    id: "15-porsi",
    what: "an off-list total, priced at the largest listed size below it",
    turns: ["halo", "kalau 15 porsi totalnya berapa kak?"],
    expect: [/420\.?000/, /28\.?000/],
    reject: [/\b29\.?500\b/, /\b44\.?000\b/],
  },
  {
    id: "7-porsi",
    what: "a total that divides by neither 5 nor 6 — refused, nearest two offered",
    turns: ["halo kak", "mau paket 7 porsi dong"],
    expect: [/\b6\b/, /\b10\b/, /174\.?000/, /280\.?000/],
    reject: [/7 porsi.{0,40}(Rp ?)?203\.?000/],
  },
  {
    id: "110-porsi",
    what: "a large off-list total — 22 box × 5 hari, the PT Bintang shape",
    turns: [
      "halo",
      "kami mau 22 box per hari buat 5 hari kerja, makan siang aja, totalnya berapa?",
      "iya makan siang aja kak, 22 box tiap hari senin sampai jumat",
    ],
    expect: [/110/, /2\.?860\.?000/, /26\.?000/],
    reject: [/belum tersedia/i, /\b2\.?915\.?000\b/],
  },
  {
    id: "skip-hari",
    what: "skipping a day never shrinks the package",
    turns: [
      "halo kak",
      "paket 6 porsi 174 ribu ya? kalau saya skip 1 hari jadi berapa?",
    ],
    expect: [/174\.?000/],
    reject: [/\b116\.?000\b/, /\b4 porsi\b/],
  },
  {
    id: "buat-order",
    what: "a whole order, priced and written by extract_order",
    seed: {
      address: "Cluster Allogio Timur 3 No. 32, Gading Serpong",
      area: "Gading Serpong",
      google_maps_link: "https://maps.app.goo.gl/S1mPr1c1ngT3st",
    },
    turns: [
      "halo kak mau pesan catering",
      "atas nama Rio ya, 1 porsi siang, senin sampai sabtu minggu depan",
      "iya betul, alamatnya sudah ada di kakak ya",
      "ukuran S aja kak. hari Senin sampai Sabtu minggu depan, siang semua. lanjut ya",
    ],
    expect: [/174\.?000/],
    expectOrder: { package_size: 6, price_per_portion: 29000 },
  },
];

function payloadFor(phone: string, text: string, n: number): WhatsAppWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "SIMPRICING",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "SIMPRICING",
                phone_number_id: "SIMPRICING",
              },
              messages: [
                {
                  id: `wamid.SIMPRICING_${RUN_NONCE}_${phone}_${n}`,
                  from: phone,
                  type: "text",
                  timestamp: String(Math.floor(Date.now() / 1000)),
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

async function cleanup(phone: string): Promise<void> {
  const db = createAdminClient();
  const { data: customer } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();
  if (!customer) return;
  const id = customer.id;
  const { data: orders } = await db
    .from("orders")
    .select("id")
    .eq("customer_id", id);
  for (const o of orders ?? []) {
    await db.from("daily_deliveries").delete().eq("order_id", o.id);
    await db.from("orders").delete().eq("id", o.id);
  }
  await db.from("conversations").delete().eq("customer_id", id);
  await db.from("customer_flags").delete().eq("customer_id", id);
  await db.from("customer_state").delete().eq("customer_id", id);
  await db.from("customer_rate_limits").delete().eq("customer_id", id);
  await db.from("customers").delete().eq("id", id);
}

async function runCase(c: Case): Promise<boolean> {
  const db = createAdminClient();
  // `parseMessage` prefixes a "+" onto every inbound `from`, so the customer the
  // pipeline creates is "+DEMO_x"; seeding the bare form leaves an orphan row.
  const phone = `+${DEMO_PHONE_PREFIX}PRICE${c.id.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  await cleanup(phone);
  const { error } = await db.from("customers").insert({
    phone_number: phone,
    name: demoDisplayName(phone),
    ...(c.seed ?? {}),
  });
  if (error) throw new Error(`demo customer insert failed: ${error.message}`);

  for (const [i, text] of c.turns.entries()) {
    const startedAt = Date.now();
    await processWebhookAsync(payloadFor(phone, text, i));
    console.log(
      `  · ${c.id} turn ${i + 1}/${c.turns.length} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
  }

  const { data: customer } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();
  const { data: msgs } = await db
    .from("conversations")
    .select("role, content, created_at")
    .eq("customer_id", customer?.id ?? "")
    .order("created_at");
  const replies = (msgs ?? [])
    .filter((m) => m.role === "assistant")
    .map((m) => m.content ?? "")
    .join("\n");

  const misses = c.expect.filter((e) =>
    typeof e === "string" ? !replies.includes(e) : !e.test(replies),
  );
  const wrong = (c.reject ?? []).filter((e) =>
    typeof e === "string" ? replies.includes(e) : e.test(replies),
  );

  let orderNote = "";
  if (c.expectOrder) {
    const { data: order } = await db
      .from("orders")
      .select("package_size, price_per_portion, total_price")
      .eq("customer_id", customer?.id ?? "")
      .maybeSingle();
    if (!order) orderNote = "no order created";
    else if (
      order.package_size !== c.expectOrder.package_size ||
      order.price_per_portion !== c.expectOrder.price_per_portion
    )
      orderNote = `order is ${order.package_size} porsi at ${order.price_per_portion} (wanted ${c.expectOrder.package_size} at ${c.expectOrder.price_per_portion})`;
    else
      orderNote = `order ok: ${order.package_size} porsi at ${order.price_per_portion}, total ${order.total_price}`;
  }

  const ok = misses.length === 0 && wrong.length === 0 && !orderNote.includes("no order") && !orderNote.includes("wanted");
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${c.id} — ${c.what}`);
  if (misses.length) console.log(`  missing: ${misses.map(String).join(", ")}`);
  if (wrong.length) console.log(`  present and should not be: ${wrong.map(String).join(", ")}`);
  if (orderNote) console.log(`  ${orderNote}`);
  console.log("  --- transcript ---");
  for (const m of msgs ?? [])
    console.log(`  ${m.role === "user" ? ">" : "<"} ${(m.content ?? "").replace(/\n/g, "\n    ")}`);

  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];
  const keep = args.includes("--keep");
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;

  const results: { id: string; ok: boolean }[] = [];
  for (const c of cases) {
    try {
      results.push({ id: c.id, ok: await runCase(c) });
    } catch (err) {
      console.log(`\nFAIL  ${c.id} — threw: ${(err as Error).message}`);
      results.push({ id: c.id, ok: false });
    }
    if (!keep)
      await cleanup(
        `+${DEMO_PHONE_PREFIX}PRICE${c.id.toUpperCase().replace(/[^A-Z0-9]/g, "")}`,
      );
  }

  console.log("\n=== summary ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
