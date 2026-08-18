/**
 * Replays real ordering conversations against the live chatbot pipeline and
 * checks whether the bot still produces the order — and the deliveries — that
 * the real conversation produced.
 *
 *   tsx scripts/replay-orders.ts [--count=20] [--only=<order-id-prefix>] [--keep]
 *
 * How it stays safe to run against production data:
 *  - every replay talks to a demo customer whose phone_number starts DEMO_,
 *    and `src/lib/whatsapp/client.ts` refuses to hand any DEMO_ recipient to
 *    Meta, so no message can reach a real phone from any code path;
 *  - the demo customer and everything it created are deleted at the end
 *    (`--keep` to inspect a failure);
 *  - `Date` is pinned to each message's original timestamp for the duration of
 *    the turn, so "besok" and "senin depan" mean what they meant at the time and
 *    the expected delivery dates stay comparable.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCorpus, type CorpusCase } from "./replay-corpus";
import { processWebhookAsync } from "../src/app/api/webhook/whatsapp/route";
import { NASI_MERAH_SURCHARGE } from "../src/lib/claude/extract-order";
import { createAdminClient } from "../src/lib/supabase/admin";
import { DEMO_PHONE_PREFIX } from "../src/lib/whatsapp/demo";
import type { WhatsAppWebhookPayload } from "../src/lib/whatsapp/types";

// ---------------------------------------------------------------------------
// Pinned clock
// ---------------------------------------------------------------------------

const RealDate = Date;

/** Runs fn with `new Date()` / `Date.now()` frozen at `iso`. */
async function atTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const fixed = new RealDate(iso).getTime();
  class PinnedDate extends RealDate {
    // biome-ignore lint/suspicious/noExplicitAny: Date's constructor overloads cannot be spread type-safely
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed);
      // biome-ignore lint/suspicious/noExplicitAny: same
      else super(...(args as [any]));
    }
    static now() {
      return fixed;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

// Every replay needs message ids nobody has used before: `processed_messages` is
// append-only by design (nothing may delete from it), so a deterministic id makes
// the second run of a case a no-op — every turn is skipped as already-processed
// and the run reports "NO ORDER CREATED" with no bug behind it.
const RUN_NONCE = Math.random().toString(36).slice(2, 10).toUpperCase();

function payloadFor(phone: string, text: string, at: string, n: number): WhatsAppWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "REPLAY",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "REPLAY", phone_number_id: "REPLAY" },
              messages: [
                {
                  id: `wamid.REPLAY_${RUN_NONCE}_${phone}_${n}`,
                  from: phone,
                  type: "text",
                  timestamp: String(Math.floor(new RealDate(at).getTime() / 1000)),
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

interface Result {
  orderId: string;
  name: string | null;
  turns: number;
  ok: boolean;
  notes: string[];
  got: { packageSize: number; pricePerPortion: number; totalPrice: number; deliveries: string[] } | null;
  expected: CorpusCase["expected"];
  /** What the bot actually said, so a failure can be read instead of guessed at. */
  transcript: { role: string; content: string }[];
}

async function replayCase(c: CorpusCase): Promise<Result> {
  const db = createAdminClient();
  // `parseMessage` prefixes a "+" onto every inbound `from`, so the customer the
  // pipeline creates is "+DEMO_x". Seeding the bare form left an orphan row the
  // webhook ignored — assertions then read an empty customer and reported a
  // phantom "NO ORDER CREATED", while the real demo rows survived the sweep.
  const phone = `+${DEMO_PHONE_PREFIX}${c.orderId.slice(0, 8)}`;

  await cleanupDemo(phone);
  const { data: demo, error } = await db
    .from("customers")
    .insert({ phone_number: phone, name: null })
    .select("id")
    .single();
  if (error || !demo) throw new Error(`demo customer insert failed: ${error?.message}`);

  // A case is one whole conversation against the live model, so a run is silent
  // for minutes at a time between verdicts. Printing each turn as it lands makes
  // a stalled case distinguishable from a slow one while the run is still going.
  const label = (c.customerName ?? "?").slice(0, 18);
  for (const [i, turn] of c.turns.entries()) {
    const startedAt = Date.now();
    try {
      await atTime(turn.at, () =>
        processWebhookAsync(payloadFor(phone, turn.text, turn.at, i)),
      );
      console.log(
        `  · ${label} turn ${i + 1}/${c.turns.length} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    } catch (err) {
      console.log(`  · ${label} turn ${i + 1}/${c.turns.length} THREW ${(err as Error).message}`);
    }
  }

  const { data: orders } = await db
    .from("orders")
    .select("id, package_size, price_per_portion, total_price")
    .eq("customer_id", demo.id)
    .order("created_at", { ascending: false });
  const order = orders?.[0] ?? null;
  const { data: dels } = await db
    .from("daily_deliveries")
    .select("delivery_date")
    .eq("customer_id", demo.id)
    .order("delivery_date");

  const { data: convo } = await db
    .from("conversations")
    .select("role, content")
    .eq("customer_id", demo.id)
    .order("created_at");

  const notes: string[] = [];
  const got = order
    ? {
        packageSize: order.package_size,
        pricePerPortion: order.price_per_portion,
        totalPrice: order.total_price,
        deliveries: (dels ?? []).map((d) => d.delivery_date),
      }
    : null;

  if (!got) {
    notes.push("NO ORDER CREATED");
  } else {
    if (got.packageSize !== c.expected.packageSize)
      notes.push(`package ${got.packageSize} != ${c.expected.packageSize}`);
    // Price is checked against what today's rules produce for that package, not
    // against the historical figure. Two of the twenty were sold under rules
    // that no longer exist — PT Bintang's Rp 35.000/porsi is corporate pricing
    // no tier yields, and Fidela's 8 porsi is not a sellable total any more —
    // so demanding the old number would score the bot for refusing to break a
    // current rule. A case whose history and current rules disagree is reported
    // as DRIFT with both numbers, never silently passed.
    const rulePrice = await currentRulePrice(c.expected.packageSize, c.expected.pricePerPortion);
    if (rulePrice === null) {
      notes.push(
        `DRIFT: package ${c.expected.packageSize} is not sellable under current rules (sold at ${c.expected.pricePerPortion}); bot wrote ${got.pricePerPortion}`,
      );
    } else if (got.pricePerPortion !== rulePrice) {
      notes.push(
        `price/porsi ${got.pricePerPortion} != ${rulePrice}${rulePrice === c.expected.pricePerPortion ? "" : ` (current rules; sold at ${c.expected.pricePerPortion})`}`,
      );
    }
    if (c.expected.deliveryDates.length > 0 && got.deliveries.length === 0)
      notes.push(`no deliveries (real order had ${c.expected.deliveryDates.length})`);
  }

  return {
    orderId: c.orderId,
    name: c.customerName,
    turns: c.turns.length,
    ok: notes.length === 0,
    notes,
    got,
    expected: c.expected,
    transcript: (convo ?? []).map((m) => ({ role: m.role, content: m.content ?? "" })),
  };
}

// Today's price for a package size: the largest listed tier at or below the
// total, times the total, plus the nasi merah surcharge when the historical
// order carried one (the add-on is a customer request, not a pricing rule).
// Returns null when the size is not sellable at all — not on the tier list and
// divisible by neither 5 nor 6.
async function currentRulePrice(
  packageSize: number,
  historicalPrice: number,
): Promise<number | null> {
  const db = createAdminClient();
  const { data: tiers } = await db
    .from("pricing_tiers")
    .select("portions, price_per_portion")
    .order("portions", { ascending: false });
  const rows = tiers ?? [];
  const exact = rows.find((t) => t.portions === packageSize);
  const below = rows.find((t) => t.portions <= packageSize);
  if (!exact && packageSize % 5 !== 0 && packageSize % 6 !== 0) return null;
  const base = (exact ?? below)?.price_per_portion;
  if (base === undefined) return null;
  const addon = historicalPrice - base;
  return addon === NASI_MERAH_SURCHARGE ? base + addon : base;
}

// ---------------------------------------------------------------------------
// Cleanup — demo rows must never outlive the run
// ---------------------------------------------------------------------------

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

async function cleanupAllDemos(): Promise<number> {
  const db = createAdminClient();
  const { data } = await db
    .from("customers")
    .select("phone_number")
    .like("phone_number", `%${DEMO_PHONE_PREFIX}%`);
  for (const c of data ?? []) await cleanupDemo(c.phone_number);
  return (data ?? []).length;
}

async function main() {
  const args = process.argv.slice(2);
  const count = Number(args.find((a) => a.startsWith("--count="))?.split("=")[1] ?? 20);
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];
  const keep = args.includes("--keep");
  // Transcripts are printed in the summary, which only lands when the whole run
  // is over — 20 conversations is an hour of model calls, and a run that is
  // killed part-way (or simply still going) leaves nothing to read. Written per
  // case, a failure is diagnosable while the rest of the round continues.
  const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 5);
  const outDir = args.find((a) => a.startsWith("--out="))?.split("=")[1];
  const slice = args.find((a) => a.startsWith("--slice="))?.split("=")[1];
  if (outDir) mkdirSync(outDir, { recursive: true });

  if (args.includes("--cleanup-only")) {
    console.log(`cleaned ${await cleanupAllDemos()} demo customers`);
    return;
  }

  let cases = await buildCorpus(count);
  if (only) cases = cases.filter((c) => c.orderId.startsWith(only));

  // Parent mode: fan the corpus out over `concurrency` child processes and just
  // relay their output. Each child owns its own global Date, which is the whole
  // reason this is processes and not promises.
  if (!slice && concurrency > 1 && cases.length > 1) {
    const workers = Math.min(concurrency, cases.length);
    console.log(`replaying ${cases.length} conversations over ${workers} processes\n`);
    const childArgs = args.filter(
      (a) => !a.startsWith("--concurrency=") && !a.startsWith("--slice="),
    );
    const codes = await Promise.all(
      Array.from({ length: workers }, (_, k) =>
        new Promise<number>((resolve) => {
          const child = spawn(
            "npx",
            ["tsx", "scripts/replay-orders.ts", ...childArgs, `--slice=${k}/${workers}`],
            { stdio: ["ignore", "inherit", "inherit"] },
          );
          child.on("close", (code) => resolve(code ?? 0));
        }),
      ),
    );
    if (!keep) console.log(`\ndemo rows cleaned: ${await cleanupAllDemos()} leftover`);
    process.exit(codes.some((c) => c !== 0) ? 1 : 0);
  }

  if (slice) {
    const [k, n] = slice.split("/").map(Number);
    cases = cases.filter((_, i) => i % n === k);
  }
  console.log(`replaying ${cases.length} conversations\n`);

  const results: Result[] = [];
  let next = 0;
  // Cases run one at a time inside a process. They used to run as a pool of
  // in-process workers, and that was silently wrong: `atTime` pins the clock by
  // replacing the global Date, so seven concurrent cases overwrote each other's
  // pin and a turn could be processed under another case's date. "besok" then
  // resolved to the wrong day. The tell was the per-turn timer printing 476345s
  // for a turn that took seconds. Parallelism now comes from child processes
  // (--slice), which have their own globals.
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= cases.length) return;
      const c = cases[i];
      try {
        const r = await replayCase(c);
        results.push(r);
        console.log(`[${i + 1}/${cases.length}] ${c.customerName ?? "?"} ${c.orderId.slice(0, 8)} (${c.turns.length} turns) ... ${r.ok ? "PASS" : `FAIL — ${r.notes.join("; ")}`}`);
        if (outDir) {
          writeFileSync(
            join(outDir, `${r.orderId.slice(0, 8)}.json`),
            JSON.stringify({ ...r, turns: c.turns }, null, 1),
          );
        }
      } catch (err) {
        console.log(`[${i + 1}/${cases.length}] ${c.customerName ?? "?"} ${c.orderId.slice(0, 8)} ... ERROR — ${(err as Error).message}`);
        results.push({ orderId: c.orderId, name: c.customerName, turns: c.turns.length, ok: false, notes: [`threw: ${(err as Error).message}`], got: null, expected: c.expected, transcript: [] });
      }
      if (!keep) await cleanupDemo(`+${DEMO_PHONE_PREFIX}${c.orderId.slice(0, 8)}`);
    }
  }
  await worker();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`\n${r.name ?? "?"} ${r.orderId.slice(0, 8)} (${r.turns} turns)`);
    console.log(`  expected pkg=${r.expected.packageSize} @${r.expected.pricePerPortion} deliveries=${r.expected.deliveryDates.length}`);
    console.log(`  got      ${r.got ? `pkg=${r.got.packageSize} @${r.got.pricePerPortion} deliveries=${r.got.deliveries.length}` : "nothing"}`);
    for (const n of r.notes) console.log(`  - ${n}`);
    for (const m of r.transcript) {
      const body = m.content.replace(/\s+/g, " ").slice(0, 220);
      console.log(`    ${m.role === "user" ? ">>" : "<<"} ${body}`);
    }
  }
  // Only the parent sweeps: a shard calling cleanupAllDemos() would delete the
  // customers its siblings are still replaying against.
  if (!keep && !slice) console.log(`\ndemo rows cleaned: ${await cleanupAllDemos()} leftover`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
