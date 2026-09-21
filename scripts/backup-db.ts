/**
 * Dumps every table in the public schema to one gzipped JSON file.
 *
 *   pnpm backup                     write to .backup/
 *   pnpm backup /path/to/dir        write somewhere else
 *
 * Exit codes: 0 every table dumped, 1 one or more tables failed.
 *
 * There was no backup of this database until 2026-09-21. Supabase Free has no
 * point-in-time recovery, so a bad write — a script with a wrong `WHERE`, a
 * delete that matched more rows than intended — was unrecoverable, and the
 * only copy of anything was one CSV of `daily_deliveries` from 11 September.
 * That became load-bearing once a second person started running fixes against
 * production unattended.
 *
 * The schema is already in git under supabase/migrations, so this dumps data
 * only. A restore is: apply the migrations, then load these rows back.
 *
 * Two things this file will not do:
 *
 * - It does not carry a hardcoded table list. The tables come from PostgREST's
 *   OpenAPI document at /rest/v1/, so a table added next month is in the next
 *   backup without anyone remembering this file exists. A list here would go
 *   stale silently, and a backup missing a table looks exactly like a backup.
 *
 * - It does not use a bare select. `fetchAllRows()` walks every table with
 *   .range(), because PostgREST caps an unpaginated select at 1000 rows and
 *   says nothing when it truncates. A backup is the worst possible place for
 *   that bug: 1000 of 1660 rows restores clean and looks right.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { fetchAllRows } from "../src/lib/supabase/fetch-all";

const DEFAULT_OUT = ".backup";

/**
 * The tables PostgREST will serve, read from its OpenAPI document. Views come
 * back in the same list and are dropped — they are derived, so backing them up
 * stores the same rows twice and restoring them would fail.
 */
async function listTables(url: string, key: string): Promise<string[]> {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAPI read failed: ${res.status} ${res.statusText}`);
  }
  const spec = (await res.json()) as {
    definitions?: Record<string, unknown>;
    paths?: Record<string, Record<string, unknown>>;
  };
  const names = Object.keys(spec.definitions ?? {});
  if (names.length === 0) throw new Error("OpenAPI listed no tables");

  // A view has no insert/patch/delete verb on its path. Anything writable is a
  // real table.
  return names
    .filter((name) => {
      const verbs = spec.paths?.[`/${name}`];
      return verbs ? "post" in verbs || "patch" in verbs : false;
    })
    .sort();
}

async function main() {
  const outDir = process.argv[2] ?? DEFAULT_OUT;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set",
    );
    process.exit(1);
  }

  // Not createAdminClient(): its client is typed against src/types/database.ts,
  // so .from() only accepts a table name known at compile time. The whole point
  // here is a list discovered at runtime, and the row shapes are never
  // inspected — they go straight to JSON.
  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const tables = await listTables(url, key);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `pian-yi-${stamp}.json.gz`);

  const gzip = createGzip({ level: 9 });
  const written = gzip.pipe(createWriteStream(file));
  const done = new Promise<void>((resolve, reject) => {
    written.on("finish", resolve);
    written.on("error", reject);
  });

  const counts: Record<string, number> = {};
  const failed: Record<string, string> = {};

  gzip.write(
    `{"meta":{"project":${JSON.stringify(url)},"started_at":${JSON.stringify(
      startedAt.toISOString(),
    )}},"tables":{`,
  );

  let first = true;
  for (const table of tables) {
    const { rows, error } = await fetchAllRows<Record<string, unknown>>(
      (from, to) => db.from(table).select("*").range(from, to),
    );
    if (error) {
      failed[table] = error;
      console.error(`  ${table}: FAILED — ${error}`);
      continue;
    }
    counts[table] = rows.length;
    if (!first) gzip.write(",");
    first = false;
    gzip.write(`${JSON.stringify(table)}:${JSON.stringify(rows)}`);
    console.log(`  ${table}: ${rows.length}`);
  }

  gzip.write(
    `},"counts":${JSON.stringify(counts)},"failed":${JSON.stringify(failed)}}`,
  );
  gzip.end();
  await done;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const names = Object.keys(failed);
  console.log(
    `\n${file}\n${Object.keys(counts).length}/${tables.length} tables, ${total} rows`,
  );
  if (names.length > 0) {
    console.error(
      `INCOMPLETE — ${names.length} table(s) failed: ${names.join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
