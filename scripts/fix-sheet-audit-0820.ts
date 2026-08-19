/**
 * Repairs found auditing the 2026-08-20 delivery sheet against the last 50 chats.
 *
 * Four defects, all of them a row the kitchen either cannot see or should never
 * have been given:
 *
 * 1. galvent's 20 Agustus row carries subcontractor_id NULL, and /dapur/[id]
 *    filters strictly on that column — the kitchen that has to cook it never
 *    sees it. His order carries no kitchen either.
 * 2. Tio Jason's 24–28 Agustus rows point at Perut Bahagia, retired in June.
 *    Same invisibility, from the order-level override.
 * 3. Sherine Fayola said "weekdays only" twice; mark_paid generated the default
 *    Senin–Sabtu run, including Sabtu and Maulid Nabi on the 25th.
 * 4. Lina Marlianty said "tiap jumat libur"; same generation gave her Jumat,
 *    Sabtu and the 25th.
 * 5. Julian S confirmed his package has no weekend, and asked for Senin 24 and
 *    Selasa 25 dinner. The 25th is Maulid Nabi, so his three remaining portions
 *    are 24, 26 and 27 — not the Sabtu 22 he was given.
 *
 * Portion counts are preserved: every day dropped is replaced by the next day
 * the customer's own pattern allows.
 */
import { isClosedHoliday } from "@/lib/holidays/id";
import { createAdminClient } from "@/lib/supabase/admin";

const THENIE = "52cd9a52-8b7b-4c5b-8d6f-9e2a7b1c3d40";
const APPLY = process.argv.includes("--apply");

/** Delivery days from `from`, keeping only weekdays in `allowed` and skipping closures. */
function days(from: string, count: number, allowed: number[]): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    const iso = d.toISOString().slice(0, 10);
    if (allowed.includes(d.getUTCDay()) && !isClosedHoliday(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  const db = createAdminClient();
  const log = (...a: unknown[]) => console.log(APPLY ? "APPLY" : "DRY", ...a);

  const { data: kitchens } = await db.from("subcontractors").select("id,name,is_active");
  const thenie = (kitchens ?? []).find((k) => k.is_active)?.id ?? THENIE;

  const { data: customers } = await db
    .from("customers")
    .select("id,name,subcontractor_id")
    .in("name", ["galvent", "Tio Jason", "Sherine Fayola", "Lina Marlianty", "Julian S"]);
  const by = (n: string) => (customers ?? []).find((c) => c.name === n);

  // 1 + 2 — rows and orders pointing at no kitchen or a retired one.
  for (const name of ["galvent", "Tio Jason"]) {
    const c = by(name);
    if (!c) continue;
    const { data: rows } = await db
      .from("daily_deliveries")
      .select("id,delivery_date,subcontractor_id,order_id")
      .eq("customer_id", c.id)
      .gte("delivery_date", "2026-08-20");
    const bad = (rows ?? []).filter((r) => r.subcontractor_id !== thenie);
    log(name, "rows to repoint:", bad.map((r) => r.delivery_date).join(", ") || "none");
    if (APPLY && bad.length) {
      await db
        .from("daily_deliveries")
        .update({ subcontractor_id: thenie })
        .in("id", bad.map((r) => r.id));
      const orderIds = [...new Set(bad.map((r) => r.order_id).filter(Boolean))] as string[];
      await db.from("orders").update({ subcontractor_id: thenie }).in("id", orderIds);
    }
  }

  // 3, 4, 5 — schedules that disagree with what the customer asked for.
  // Julian S asked on the 19th for Kamis 20 and Jumat 21 to be skipped and the
  // portions moved to Senin 24 onward, so his run starts there, not tomorrow.
  const rebuilds: { name: string; allowed: number[]; note: string; from: string }[] = [
    { name: "Sherine Fayola", allowed: [1, 2, 3, 4, 5], note: "weekdays only", from: "2026-08-20" },
    { name: "Lina Marlianty", allowed: [1, 2, 3, 4], note: "Jumat libur", from: "2026-08-20" },
    { name: "Julian S", allowed: [1, 2, 3, 4, 5], note: "no weekend, skips 20-21", from: "2026-08-24" },
  ];

  for (const r of rebuilds) {
    const c = by(r.name);
    if (!c) continue;
    const { data: rows } = await db
      .from("daily_deliveries")
      .select("id,delivery_date,meal_type,portions,order_id")
      .eq("customer_id", c.id)
      .gte("delivery_date", "2026-08-20")
      .order("delivery_date");
    if (!rows?.length) continue;

    const orderId = rows[0].order_id as string;
    const meals = [...new Set(rows.map((x) => x.meal_type))].sort();
    const perDay = meals.length;
    const total = rows.length / perDay;
    const wanted = days(r.from, total, r.allowed);
    const have = [...new Set(rows.map((x) => x.delivery_date))].sort();

    const drop = have.filter((d) => !wanted.includes(d));
    const add = wanted.filter((d) => !have.includes(d));
    log(r.name, `(${r.note}, ${meals.join("+")})`, "drop:", drop.join(",") || "none", "| add:", add.join(",") || "none");
    if (!APPLY) continue;

    if (drop.length) {
      await db
        .from("daily_deliveries")
        .delete()
        .eq("customer_id", c.id)
        .in("delivery_date", drop);
    }
    if (add.length) {
      const tpl = rows[0];
      const inserts = add.flatMap((date) =>
        meals.map((meal) => ({
          customer_id: c.id,
          order_id: orderId,
          delivery_date: date,
          meal_type: meal,
          portions: tpl.portions,
          status: "scheduled",
          subcontractor_id: thenie,
        })),
      );
      const { error } = await db.from("daily_deliveries").insert(inserts);
      if (error) throw new Error(`${r.name}: ${error.message}`);
    }
  }
}

main().then(() => process.exit(0));
