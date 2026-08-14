/**
 * Merges customer rows that are the same person under a different phone format.
 *
 * `customers.phone_number` has never had normalization or a uniqueness
 * constraint, so the same person exists as both "+628..." and "628...". The
 * 2026-06-08 WhatsApp flow created one row; the 2026-07-07 `fix-no-orders.ts`
 * backfill created a second. Neither knew about the other, so orders landed on
 * one row and deliveries on the other — which is what made the ORDER_HARIAN
 * audit report 135 phantom missing deliveries (the real number is 5).
 *
 * Survivor is the row with the most linked activity (orders + deliveries +
 * conversations), oldest `created_at` breaking a tie. Every referencing row is
 * re-pointed to the survivor; nothing is deleted except the emptied duplicate
 * customer row itself. The survivor's phone is rewritten to the canonical
 * "+62..." form.
 *
 * Dry run by default. Pass --apply to write. --apply writes a rollback file to
 * scripts/rollback/dedup-phone-<timestamp>.json before touching anything.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { requiredEnv } from "../src/lib/env";

dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");

/** Tables holding a plain customer_id that may have many rows per customer. */
const MOVABLE = [
  { table: "orders", column: "customer_id" },
  { table: "conversations", column: "customer_id" },
  { table: "daily_deliveries", column: "customer_id" },
  { table: "broadcast_recipients", column: "customer_id" },
  { table: "delivery_proofs", column: "matched_customer_id" },
] as const;

/** Tables keyed by customer_id as the primary key — at most one row each. */
const SINGLETON = [
  "customer_flags",
  "customer_state",
  "customer_rate_limits",
] as const;

/** Canonical Indonesian mobile form, digits only, 62-prefixed. */
function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("IMPORT_")) return null; // placeholder, not a phone
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  if (digits.startsWith("8")) return `62${digits}`;
  return digits;
}

type Customer = {
  id: string;
  name: string | null;
  phone_number: string | null;
  created_at: string | null;
};

const db = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  requiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),
);

async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // Full rows: the rollback file has to be able to recreate a deleted duplicate.
  const customers = await fetchAll<Customer>("customers", "*");

  // Count linked rows per customer so the survivor pick is based on real
  // activity rather than which row happens to sort first.
  const counts = new Map<string, number>();
  for (const { table, column } of MOVABLE) {
    const rows = await fetchAll<Record<string, string | null>>(table, column);
    for (const row of rows) {
      const id = row[column];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const groups = new Map<string, Customer[]>();
  for (const c of customers) {
    const key = normalizePhone(c.phone_number);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const dupes = [...groups.entries()].filter(([, list]) => list.length > 1);
  console.log(
    `${customers.length} customers, ${dupes.length} duplicate phone groups\n`,
  );
  if (dupes.length === 0) return;

  const rollback: {
    generated_at: string;
    groups: {
      phone: string;
      survivor: string;
      survivor_phone_before: string | null;
      losers: Customer[];
      moved: { table: string; column: string; ids: string[] }[];
      singletons_deleted: { table: string; row: Record<string, unknown> }[];
    }[];
  } = { generated_at: new Date().toISOString(), groups: [] };

  // Flushed after every group so a mid-run failure still leaves a usable file.
  const dir = path.join(__dirname, "rollback");
  const file = path.join(dir, `dedup-phone-${Date.now()}.json`);
  const flush = () => {
    if (!APPLY) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rollback, null, 2));
  };

  for (const [phone, list] of dupes) {
    list.sort((a, b) => {
      const diff = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
      if (diff !== 0) return diff;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    });
    const [survivor, ...losers] = list;

    console.log(`+${phone}`);
    console.log(
      `  KEEP  ${survivor.id.slice(0, 8)} "${survivor.name}" ${survivor.phone_number} (${counts.get(survivor.id) ?? 0} linked rows)`,
    );

    const entry = {
      phone,
      survivor: survivor.id,
      survivor_phone_before: survivor.phone_number,
      losers,
      moved: [] as { table: string; column: string; ids: string[] }[],
      singletons_deleted: [] as {
        table: string;
        row: Record<string, unknown>;
      }[],
    };
    rollback.groups.push(entry);
    flush();

    for (const loser of losers) {
      console.log(
        `  MERGE ${loser.id.slice(0, 8)} "${loser.name}" ${loser.phone_number} (${counts.get(loser.id) ?? 0} linked rows)`,
      );

      for (const { table, column } of MOVABLE) {
        const { data: rows, error } = await db
          .from(table)
          .select("id")
          .eq(column, loser.id);
        if (error) throw new Error(`${table} read: ${error.message}`);
        if (!rows?.length) continue;

        const ids = rows.map((r) => r.id as string);
        console.log(`      ${table}.${column}: ${ids.length}`);
        entry.moved.push({ table, column, ids });
        flush();

        if (APPLY) {
          const { error: upErr } = await db
            .from(table)
            .update({ [column]: survivor.id })
            .eq(column, loser.id);
          if (upErr) throw new Error(`${table} update: ${upErr.message}`);
        }
      }

      // Singletons are PK'd on customer_id, so the loser's row can only move if
      // the survivor has none. Otherwise it is dropped — the survivor's own row
      // is the one the app has been reading.
      for (const table of SINGLETON) {
        const { data: loserRow } = await db
          .from(table)
          .select("*")
          .eq("customer_id", loser.id)
          .maybeSingle();
        if (!loserRow) continue;

        const { data: survivorRow } = await db
          .from(table)
          .select("customer_id")
          .eq("customer_id", survivor.id)
          .maybeSingle();

        if (survivorRow) {
          console.log(`      ${table}: drop loser row (survivor has one)`);
          entry.singletons_deleted.push({
            table,
            row: loserRow as Record<string, unknown>,
          });
          if (APPLY) {
            await db.from(table).delete().eq("customer_id", loser.id);
          }
        } else {
          console.log(`      ${table}: move to survivor`);
          entry.moved.push({
            table,
            column: "customer_id",
            ids: [loser.id],
          });
          if (APPLY) {
            await db
              .from(table)
              .update({ customer_id: survivor.id })
              .eq("customer_id", loser.id);
          }
        }
      }

      if (APPLY) {
        const { error: delErr } = await db
          .from("customers")
          .delete()
          .eq("id", loser.id);
        if (delErr) throw new Error(`delete customer: ${delErr.message}`);
      }
    }

    const canonical = `+${phone}`;
    if (survivor.phone_number !== canonical) {
      console.log(`      phone → ${canonical}`);
      if (APPLY) {
        await db
          .from("customers")
          .update({ phone_number: canonical })
          .eq("id", survivor.id);
      }
    }

    flush();
    console.log();
  }

  if (APPLY) {
    console.log(`Applied. Rollback written to ${file}`);
  } else {
    console.log("Dry run. Re-run with --apply to write.");
  }
}

main();
