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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";

const OUT = process.env.MENU_PHOTO_DIR ?? ".menu-photos";
const MODEL = "gpt-image-2";
const SIZE = "1024x1536"; // portrait — the tray's own aspect; `deskew()` turns it landscape for the card
/**
 * A real delivery, deskewed, cropped and stripped. Passed to the model as an
 * actual image rather than described in prose: two rounds of prompt wording
 * failed to stop it plating a restaurant hero shot, and the card's footer claims
 * the photo shows the porsi a customer receives.
 *
 * It is deskewed because the model copies the reference's geometry along with
 * its portion: the handheld original leans 21° and every generated tray came
 * back at its own angle. `deskew()` below is the belt to this braces.
 */
const REFERENCE = `${process.cwd()}/scripts/assets/reference-box-2026-08-18.jpg`;

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
    // Written for the images/edits endpoint: the attached photo is a real delivery
    // (scripts/assets/reference-box-2026-08-18.jpg) and carries the tray and the
    // portion scale, so this text only has to say what food goes in it. Describing
    // the portion in prose failed twice — the model plated a restaurant hero shot
    // both times, and the card footer claims the photo shows the porsi delivered.
    "Use the attached photograph as the exact reference for the container and the portion size.",
    "Keep its black glossy four-compartment plastic tray, its overhead camera angle, its lighting,",
    "and — most importantly — how little food is in it: every compartment is only partly",
    "covered and bare black tray shows around each item. Match that emptiness exactly.",
    `Replace only the food. The compartments now hold, each in its own compartment: ${items}.`,
    "Keep the rice as one plain white scoop the same size as in the reference, no garnish.",
    "Keep the sambal in its own small well, never poured over the other food.",
    "Do not make the portions larger, do not heap or mound anything, do not fill the tray",
    "edge to edge, do not restyle it as restaurant or advertising food photography.",
    "Photorealistic, sharp, true to the named dishes.",
    "Shot straight down, perfectly square to the camera: the tray is upright and centred,",
    "its edges parallel to the edges of the frame, zero tilt and zero rotation.",
    "The whole tray is inside the frame, all four corners visible, with a small even margin.",
    "Transparent background: nothing behind or around the tray —",
    "no table, no surface, no placemat, no cutlery, no drinks, no hands, no packaging, no text, no logo, no watermark.",
  ].join(" ");
}

function editForm(
  prompt: string,
  quality: string,
  reference: string,
): FormData {
  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("size", SIZE);
  form.append("quality", quality);
  form.append("n", "1");
  form.append("background", "transparent");
  form.append("output_format", "png");
  form.append(
    "image[]",
    new Blob([new Uint8Array(readFileSync(reference))], { type: "image/jpeg" }),
    "reference.jpg",
  );
  return form;
}

async function generate(
  prompt: string,
  quality: string,
  reference: string | null,
): Promise<Buffer> {
  const res = reference
    ? await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: editForm(prompt, quality, reference),
      })
    : await fetch("https://api.openai.com/v1/images/generations", {
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

/**
 * Rotates a generated tray upright and trims the transparent margin.
 *
 * The model copies the reference's geometry, so a tilted reference produced five
 * trays at five different angles, and no amount of "zero tilt" in the prompt
 * fixed it. This does not ask: the alpha channel *is* the tray silhouette, so
 * the angle whose bounding box is smallest is the angle the tray is upright at.
 * Searched over ±25°, which is wider than any tilt seen and narrow enough that
 * the 90°-symmetric answer can never win.
 */
async function deskew(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png)
    .resize({ width: 256 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pts: number[] = [];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * info.channels + 3] > 128) pts.push(x, y);
  if (!pts.length) return png;

  let best = 0;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let deg = -25; deg <= 25; deg += 0.25) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const u = pts[i] * c - pts[i + 1] * s;
      const v = pts[i] * s + pts[i + 1] * c;
      if (u < x0) x0 = u;
      if (u > x1) x1 = u;
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      bestArea = area;
      best = deg;
    }
  }

  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const upright = await sharp(png)
    .rotate(-best, { background: transparent })
    .trim({ background: transparent, threshold: 0 })
    .png()
    .toBuffer();

  // The card lays the photos out in a wide slot, so the tray is turned on its
  // side to fill it. The generation itself stays portrait, which is the tray's
  // own aspect and spends the most pixels on it; only the last step is landscape.
  const { width = 0, height = 0 } = await sharp(upright).metadata();
  if (height <= width) return upright;
  return sharp(upright)
    .rotate(90, { background: transparent })
    .png()
    .toBuffer();
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
    const png = await deskew(await generate(prompt, quality, REFERENCE));
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
