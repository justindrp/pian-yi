/**
 * Sets (or clears) a customer's negotiated corporate rate.
 *
 *   tsx scripts/set-contract-price.ts <customer-id-or-name> <rate|null>
 */
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const [needle, rateArg] = process.argv.slice(2);
  if (!needle) throw new Error("usage: set-contract-price.ts <id|name> <rate|null>");
  const db = createAdminClient();
  const { data: matches } = await db
    .from("customers")
    .select("id, name, phone_number, contract_price_per_portion")
    .ilike("name", `%${needle}%`);
  if (!matches?.length) throw new Error(`no customer matching ${needle}`);
  if (matches.length > 1)
    throw new Error(`ambiguous: ${matches.map((m) => m.name).join(", ")}`);
  const c = matches[0];
  if (rateArg === undefined) {
    console.log(`${c.name}: contract ${c.contract_price_per_portion ?? "none"}`);
    return;
  }
  const rate = rateArg === "null" ? null : Number(rateArg);
  const { error } = await db
    .from("customers")
    .update({ contract_price_per_portion: rate })
    .eq("id", c.id);
  if (error) throw error;
  console.log(`${c.name}: contract ${c.contract_price_per_portion ?? "none"} -> ${rate ?? "none"}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
