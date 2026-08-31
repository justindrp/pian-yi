/**
 * Generates one food photo per menu day, for the weekly card (scripts/menu-card.ts).
 *
 * The photos on Batch 51's card were drawn once, by hand, in a chat window, and
 * three of the five showed food nobody cooks that week — Senin's "Chicken Katsu"
 * was plated as tempeh. A card that names a dish and shows another is worse than
 * one with no photo, so the prompt is built from `subcontractors.menu_text`
 * rather than typed: the dish names on the card and the dish names in the prompt
 * come from the same string, and cannot drift apart.
 *
 * The photo shows the **size M** line-up, which is what the card's caption
 * claims ("Foto menampilkan porsi size M"). Transparency comes from the model
 * (`background: "transparent"`), not from a cutout pass — a generated alpha edge
 * carries no colour of its own, where a knocked-out one carries whatever it was
 * shot against and haloes on any other ground.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/menu-photos.ts [--day 1] [--quality low|medium|high]
 *
 * Costs money on every run: ~$0.041 per image at medium, ~$0.005 at low.
 * Writes .menu-photos/t1.png … t5.png. Nothing is uploaded and nothing is sent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createAdminClient } from "@/lib/supabase/admin";

const OUT = process.env.MENU_PHOTO_DIR ?? ".menu-photos";
const MODEL = "gpt-image-2";
const SIZE = "1536x1024"; // landscape — the card's photo slot is wider than it is tall

type Day = { name: string; date: string; s: string[]; m: string | null };

/** The same shape `scripts/menu-card.ts` parses, read from the same column. */
function parseMenu(text: string): Day[] {
  const days: Day[] = [];
  for (const line of text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(2)) {
    const parts = line.match(/^(\w+) ([^:]+):\s*(.+)$/);
    if (!parts) continue;
    const [, name, date, rest] = parts;
    if (/Chef recommendation/i.test(rest)) continue; // no menu yet, nothing to draw
    const m = rest.match(/Tambahan size M:\s*([^.]+)\./);
    const s = rest
      .replace(/\s*Tambahan size M:.*$/, "")
      .replace(/\.$/, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    days.push({ name, date, s, m: m ? m[1].trim() : null });
  }
  return days;
}

/**
 * One prompt per day, size M line-up.
 *
 * Says what the food is and then, at length, what the frame is not: a generator
 * will otherwise add a table, a napkin, chopsticks and a second dish, and the
 * five photos stop looking like one set. Sambal is named as a small separate cup
 * because every model plates it as sauce poured over the chicken.
 */
function promptFor(day: Day): string {
  const items = [...day.s, ...(day.m ? [day.m] : [])].join("; ");
  return [
    // The tray is described from scripts/assets/reference-box-2026-08-18.jpg, a real
    // delivery. Check any change to these lines against that photo, or a newer one.
    "Top-down 90-degree food photograph of one Indonesian catering lunch portion,",
    "served in a black glossy rectangular plastic bento tray with four moulded compartments:",
    "one large compartment along the bottom for rice, a small well for sambal, and two for the rest.",
    `The compartments hold, each in its own compartment: ${items}.`,
    "Modest everyday catering portions, not a restaurant hero shot: each item covers part of its",
    "compartment and bare black tray stays visible around it. Never fill the tray edge to edge.",
    "Sambal sits in its own small separate well, never poured over the other food.",
    "Rice is one plain white steamed scoop filling about half its compartment, no garnish on it.",
    "Soft even studio light, no harsh shadow, photorealistic, sharp, appetizing, true to the named dishes.",
    "The box fills the frame. Transparent background: nothing behind or around the box —",
    "no table, no surface, no placemat, no cutlery, no drinks, no hands, no packaging, no text, no logo, no watermark.",
  ].join(" ");
}

async function generate(prompt: string, quality: string): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      size: SIZE,
      quality,
      n: 1,
      background: "transparent",
      output_format: "png",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // The key itself must never reach a log line; the message never carries it.
    throw new Error(
      `${res.status} ${body?.error?.message ?? JSON.stringify(body)}`,
    );
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64)
    throw new Error(
      `no image in response: ${JSON.stringify(body).slice(0, 300)}`,
    );
  return Buffer.from(b64, "base64");
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  const args = process.argv.slice(2);
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const quality = arg("--quality") ?? "medium";
  const only = arg("--day") ? Number(arg("--day")) : null;

  const db = createAdminClient();
  const { data: kitchens, error } = await db
    .from("subcontractors")
    .select("id, customer_nickname, menu_text")
    .eq("is_active", true);
  if (error) throw new Error(error.message);

  const kitchen = (kitchens ?? []).find(
    (k) => (k.menu_text ?? "").trim().length > 0,
  );
  if (!kitchen) throw new Error("no active kitchen has a menu_text to draw");

  const days = parseMenu(kitchen.menu_text ?? "");
  if (!days.length) throw new Error("menu_text parsed to no days");

  mkdirSync(OUT, { recursive: true });
  console.log(
    `${kitchen.customer_nickname}: ${days.length} days, quality=${quality}`,
  );

  for (const [i, day] of days.entries()) {
    const n = i + 1;
    if (only && only !== n) continue;
    const prompt = promptFor(day);
    process.stdout.write(`t${n} ${day.name} ${day.date} … `);
    const png = await generate(prompt, quality);
    writeFileSync(`${OUT}/t${n}.png`, png);
    console.log(`${(png.length / 1024).toFixed(0)} KB`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
