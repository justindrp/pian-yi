/**
 * Create the six kitchens that cooked for us between December 2025 and July
 * 2026 and never had a `subcontractors` row.
 *
 * They were found in Annie's Superbank statements, not in the app: the whole
 * period was recorded against Thenie because Thenie was the only kitchen the
 * app knew about, so 963 delivery rows carry a kitchen that did not cook them.
 * Nothing can be reattributed until the real kitchens exist as rows, and that
 * is all this script does — it creates them inactive, with no cost and no
 * areas, because the bank shows a day's bill and never a per-portion rate.
 *
 * `notes` carries the bank payee name each kitchen was identified by, which is
 * the only handle a later reattribution pass has for matching a transfer to a
 * kitchen; the names differ from the kitchen's own ("Lili Anggraini Se" is
 * Catering Bintaro BSD) and nothing else in the database records the link.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/create-2025-kitchens.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

type NewKitchen = {
  name: string;
  customer_nickname: string;
  payee: string;
  paid: string;
};

// The nickname is a placeholder on the plant convention the existing kitchens
// use (Palem, Suplir, Aglonema, Puring, Kaktus, Andong, Monstera). None of
// these six is active, so no customer sees one until an admin renames it.
const KITCHENS: NewKitchen[] = [
  {
    name: "Catering Bintaro BSD",
    customer_nickname: "Dapur Melati",
    payee: "Lili Anggraini Se",
    paid: "Rp 2.657.000 Des 2025–Jun 2026 (Annie), Rp 753.000 Jul 2026 (Agnes)",
  },
  {
    name: "Pangkha Catering",
    customer_nickname: "Dapur Anggrek",
    payee: "Fenti Afriltia",
    paid: "Rp 3.772.000 Des 2025–Jun 2026 (Annie)",
  },
  {
    name: "Hanvin Kitchen",
    customer_nickname: "Dapur Bambu",
    payee: "Elvina Puspita Dewi",
    paid: "Rp 1.312.000 Des 2025–Jun 2026 (Annie)",
  },
  {
    name: "Family Nusantara Catering",
    customer_nickname: "Dapur Pakis",
    payee: "Pembayaran ke Family Nusantara Caterin",
    paid: "Rp 299.000 Des 2025–Jun 2026 (Annie)",
  },
  {
    name: "Cendana Catering",
    customer_nickname: "Dapur Sirih",
    payee: "Grace Sinthike Kewas",
    paid: "Rp 216.000, satu tagihan 15 Jan 2026 (Annie)",
  },
  {
    name: "Katering Karawaci (nama belum diketahui)",
    customer_nickname: "Dapur Kemuning",
    payee: "Laela Sakinah",
    paid: "Rp 60.000, 27 Jan dan 5 Feb 2026 (Annie)",
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: existing, error } = await db
    .from("subcontractors")
    .select("id, name, customer_nickname");
  if (error) throw new Error(error.message);

  const names = new Set((existing ?? []).map((s) => s.name.toLowerCase()));
  const nicknames = new Set(
    (existing ?? []).map((s) => (s.customer_nickname ?? "").toLowerCase()),
  );

  const rows = [];
  for (const k of KITCHENS) {
    if (names.has(k.name.toLowerCase())) {
      console.log(`  skip ${k.name} — already exists`);
      continue;
    }
    if (nicknames.has(k.customer_nickname.toLowerCase())) {
      throw new Error(`nickname taken: ${k.customer_nickname}`);
    }
    nicknames.add(k.customer_nickname.toLowerCase());
    rows.push({
      name: k.name,
      customer_nickname: k.customer_nickname,
      // Inactive: none of them is cooking for us now, and an active kitchen
      // with no areas and no cost would offer itself to a customer.
      is_active: false,
      cost_per_portion: 0,
      delivery_areas: [],
      delivery_days: [1, 2, 3, 4, 5, 6],
      notes: `Dapur historis Des 2025–Jul 2026. Nama di mutasi bank: "${k.payee}". Dibayar ${k.paid}. Tarif per porsi belum diketahui — mutasi hanya mencatat tagihan harian.`,
    });
    console.log(`  ${apply ? "insert" : "would insert"} ${k.name} (${k.customer_nickname}) — payee "${k.payee}"`);
  }

  if (rows.length === 0) {
    console.log("\nnothing to do");
    return;
  }
  if (!apply) {
    console.log(`\ndry run — ${rows.length} row(s). Re-run with --apply.`);
    return;
  }

  const { data: inserted, error: insErr } = await db
    .from("subcontractors")
    .insert(rows)
    .select("id, name");
  if (insErr) throw new Error(insErr.message);
  for (const r of inserted ?? []) console.log(`  created ${r.id} ${r.name}`);
  console.log(`\n${inserted?.length ?? 0} created`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
