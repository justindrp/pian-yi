/**
 * Probe: does a Meta template actually reach a customer whose 24h service
 * window is shut?
 *
 * Every delivery-proof template sent outside the window has failed since June,
 * while every in-window send succeeded. Meta only explains the failure in the
 * status webhook's errors[], which the webhook now persists to
 * conversations.whatsapp_error (migration 069). This script picks a target with
 * a long-shut window, sends a template, waits for the receipt to land on a
 * throwaway conversations row, prints the code, and deletes the row.
 *
 * Usage: npx tsx scripts/probe-template-window.ts [template] [phone]
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const TOKEN = process.env.WHATSAPP_TOKEN as string;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID as string;
const VERSION = process.env.WHATSAPP_API_VERSION ?? "v25.0";

const templateName = process.argv[2] ?? "hello_world";
const forcedPhone = process.argv[3] ?? null;

const db = createClient(SUPABASE_URL, SERVICE_KEY);

type Target = {
  id: string | null;
  name: string | null;
  phone: string;
  hoursSilent: number;
};

async function pickTarget(): Promise<Target> {
  if (forcedPhone) {
    const { data } = await db
      .from("customers")
      .select("id, name, phone_number")
      .eq("phone_number", forcedPhone)
      .maybeSingle();
    // A forced phone need not be a customer — testing against one of our own
    // numbers is the cleanest probe. The receipt row then carries no customer.
    if (!data)
      return {
        id: null,
        name: "(not a customer)",
        phone: forcedPhone,
        hoursSilent: -1,
      };
    return {
      id: data.id,
      name: data.name,
      phone: data.phone_number,
      hoursSilent: -1,
    };
  }

  // Newest inbound message per customer. Paginated in full: a single
  // newest-first slice silently excludes exactly the customers we want, since
  // the longest-silent ones fall off the end of it.
  const newest = new Map<
    string,
    { at: number; c: { id: string; name: string | null; phone_number: string } }
  >();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await db
      .from("conversations")
      .select("created_at, customers!inner(id, name, phone_number)")
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of rows ?? []) {
      const c = r.customers as unknown as {
        id: string;
        name: string | null;
        phone_number: string;
      };
      if (!c?.phone_number?.startsWith("+62")) continue;
      newest.set(c.id, { at: Date.parse(r.created_at as string), c });
    }
    if (!rows || rows.length < PAGE) break;
  }

  const now = Date.now();
  const candidates = [...newest.values()]
    .map((v) => ({ ...v, hours: (now - v.at) / 3600000 }))
    .filter((v) => v.hours > 24 * 30) // silent over a month
    .sort((a, b) => b.hours - a.hours);

  if (candidates.length === 0)
    throw new Error("No customer silent for more than 30 days");
  const pick =
    candidates[Math.floor(Math.random() * Math.min(20, candidates.length))];
  return {
    id: pick.c.id,
    name: pick.c.name,
    phone: pick.c.phone_number,
    hoursSilent: pick.hours,
  };
}

async function uploadHeaderImage(): Promise<string> {
  // delivery_proof carries an IMAGE header, so the probe needs a media id.
  // Reuse a real proof photo — the point is to reproduce the exact send.
  const { data: proof } = await db
    .from("delivery_proofs")
    .select("image_url")
    .not("image_url", "is", null)
    .order("received_at", { ascending: false })
    .limit(1)
    .single();
  if (!proof?.image_url) throw new Error("no delivery proof image to reuse");
  const path = proof.image_url.split("/delivery-proofs/")[1];
  const { data: signed } = await db.storage
    .from("delivery-proofs")
    .createSignedUrl(path, 600);
  if (!signed?.signedUrl) throw new Error("could not sign proof image url");

  const bytes = Buffer.from(
    await (await fetch(signed.signedUrl)).arrayBuffer(),
  );
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), "proof.jpg");
  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/${PHONE_ID}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    },
  );
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error(`media upload failed: ${JSON.stringify(json)}`);
  return json.id;
}

async function sendTemplate(to: string, name: string): Promise<string> {
  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/${PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name,
          language: { code: name === "hello_world" ? "en_US" : "id" },
          ...(name === "delivery_proof"
            ? {
                components: [
                  {
                    type: "header",
                    parameters: [
                      {
                        type: "image",
                        image: { id: await uploadHeaderImage() },
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
      }),
    },
  );
  const json = (await res.json()) as {
    messages?: Array<{ id: string; message_status?: string }>;
    error?: unknown;
  };
  if (!res.ok || !json.messages?.[0]?.id) {
    throw new Error(`send rejected at API time: ${JSON.stringify(json)}`);
  }
  console.log(
    "  accepted, message_status:",
    json.messages[0].message_status ?? "(none)",
  );
  return json.messages[0].id;
}

async function main(): Promise<void> {
  const target = await pickTarget();
  console.log(
    `Target: ${target.name ?? "(no name)"} ${target.phone}` +
      (target.hoursSilent > 0
        ? ` — silent ${Math.round(target.hoursSilent / 24)} days`
        : ""),
  );
  console.log(`Template: ${templateName}`);

  const { data: row, error: insErr } = await db
    .from("conversations")
    .insert({
      customer_id: target.id,
      role: "assistant",
      content: `[probe] template window test (${templateName})`,
      message_type: "text",
      model_used: "system",
    })
    .select("id")
    .single();
  if (insErr || !row)
    throw new Error(`probe row insert failed: ${insErr?.message}`);

  let wamid: string;
  try {
    wamid = await sendTemplate(target.phone, templateName);
  } catch (err) {
    await db.from("conversations").delete().eq("id", row.id);
    throw err;
  }
  console.log("  wamid:", wamid);

  await db
    .from("conversations")
    .update({ message_id: wamid, whatsapp_status: "sent" })
    .eq("id", row.id);

  // Meta posts sent → delivered/failed within seconds. Poll until a terminal
  // state or two minutes, whichever comes first.
  const deadline = Date.now() + 120_000;
  let final: {
    whatsapp_status: string | null;
    whatsapp_error: unknown;
  } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data } = await db
      .from("conversations")
      .select("whatsapp_status, whatsapp_error")
      .eq("id", row.id)
      .single();
    if (!data) continue;
    process.stdout.write(`  status: ${data.whatsapp_status}\r`);
    if (
      data.whatsapp_status === "failed" ||
      data.whatsapp_status === "delivered" ||
      data.whatsapp_status === "read"
    ) {
      final = data;
      break;
    }
  }

  console.log("\n--- RESULT ---");
  if (!final) {
    console.log(
      "No terminal receipt within 120s (still 'sent'). Meta never resolved it.",
    );
  } else {
    console.log("status:", final.whatsapp_status);
    console.log("error:", JSON.stringify(final.whatsapp_error, null, 1));
  }

  await db.from("conversations").delete().eq("id", row.id);
  console.log("probe row deleted");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
