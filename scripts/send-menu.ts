/**
 * Sends a customer their kitchen's menu image, the way the bot's
 * `send_menu_image` tool does — same kitchen narrowing, same caption, same
 * conversation row. For a thread the bot is parked on.
 *   tsx --env-file=.env.local scripts/send-menu.ts +62... [--apply]
 *
 * The env file has to come from node, not a dotenv call in here: BASE_URL in
 * whatsapp/client.ts is built at module load.
 */
import {
  saveMessage,
  updateMessageReceipt,
} from "../src/lib/claude/conversation";
import { formatMenuWeekRange } from "../src/lib/menu/week";
import { kitchensForCustomer } from "../src/lib/subcontractors/for-customer";
import { createAdminClient } from "../src/lib/supabase/admin";
import { sendImageByUrl } from "../src/lib/whatsapp/client";

async function main() {
  const phone = process.argv[2];
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: cust } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (!cust) throw new Error(`no customer ${phone}`);

  const { data: last } = await db
    .from("conversations")
    .select("created_at")
    .eq("customer_id", cust.id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const hours = last?.created_at
    ? (Date.now() - new Date(last.created_at).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  const kitchens = (await kitchensForCustomer(db, cust.id)).filter(
    (s) => !!s.menu_image_url,
  );
  console.log(
    `${cust.name ?? "(no name)"} ${phone} — window ${hours < 24 ? "OPEN" : "SHUT"} (${hours.toFixed(1)}h)`,
  );
  for (const s of kitchens) {
    console.log(`  ${s.customer_nickname} — week ${s.menu_week_start} — ${s.menu_image_url}`);
  }
  if (kitchens.length === 0) throw new Error("no kitchen with a menu image");
  if (!apply) return console.log("dry run — pass --apply");
  if (hours >= 24) throw new Error("window shut");

  for (const sub of kitchens) {
    const menuUrl = sub.menu_image_url as string;
    const caption = [
      sub.customer_nickname ? `Menu ${sub.customer_nickname}` : "Menu Dapur",
      sub.menu_week_start ? formatMenuWeekRange(sub.menu_week_start) : null,
    ]
      .filter(Boolean)
      .join(" — ");
    const conversationId = await saveMessage({
      customerId: cust.id,
      role: "assistant",
      content: menuUrl,
      messageType: "image",
      modelUsed: "system",
      sentBy: "script:send-menu",
    });
    const whatsappMessageId = await sendImageByUrl(phone, menuUrl, caption);
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId,
      status: "sent",
    });
    console.log(`sent ${caption} — ${whatsappMessageId}`);
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
