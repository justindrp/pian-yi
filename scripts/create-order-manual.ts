/**
 * Creates an order the bot failed to create, through the same helper the
 * webhook uses — so pricing, the daily_deliveries rows, the customer record and
 * the payment-details WhatsApp message all follow the normal path.
 *
 *   tsx scripts/create-order-manual.ts +62... ./order.json [--apply] [--no-payment]
 *
 * order.json is an ExtractedOrderInput; delivery_schedule is what writes the
 * delivery rows, so include every date (holidays already removed).
 */
import { readFileSync } from "node:fs";
import {
  createOrderFromExtraction,
  type ExtractedOrderInput,
} from "../src/lib/claude/extract-order";
import { getExtractedOrderPricing } from "../src/lib/claude/extract-order";
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const [phone, file] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  const sendPaymentInfo = !process.argv.includes("--no-payment");
  const input = JSON.parse(readFileSync(file, "utf8")) as ExtractedOrderInput;

  const db = createAdminClient();
  const { data: cust } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (!cust) throw new Error(`no customer ${phone}`);

  const schedule = input.delivery_schedule ?? [];
  const size = schedule.length
    ? schedule.reduce((n, s) => n + s.portions, 0)
    : input.package_size;
  const pricing = await getExtractedOrderPricing(size);

  console.log(JSON.stringify(input, null, 1));
  console.log(`\npackage ${size} porsi @ ${pricing.price_per_portion} = Rp ${pricing.total_price}`);
  console.log(`delivery rows: ${schedule.length}`);
  console.log(`payment message: ${sendPaymentInfo ? "WILL BE SENT" : "suppressed"}`);
  if (!apply) return console.log("\ndry run — pass --apply");

  await createOrderFromExtraction(cust.id, phone, input, { sendPaymentInfo });

  const { data: ords } = await db
    .from("orders")
    .select("id, status, package_size, portions_remaining, total_price")
    .eq("customer_id", cust.id);
  const { data: dels } = await db
    .from("daily_deliveries")
    .select("delivery_date, meal_type, portions")
    .eq("customer_id", cust.id)
    .order("delivery_date");
  console.log("\norders:", JSON.stringify(ords));
  console.log("deliveries:", (dels ?? []).map((d) => `${d.delivery_date} ${d.meal_type} ${d.portions}p`).join(", "));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
