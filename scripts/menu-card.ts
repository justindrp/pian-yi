/**
 * Renders the weekly menu card (1080×1350, the size WhatsApp and Instagram want)
 * from `subcontractors.menu_text` plus the photos scripts/menu-photos.ts wrote.
 *
 * Every string on the card is read, never typed: the batch and dates, the dishes,
 * the size M item, that kitchen's own surcharge
 * (`subcontractors.size_m_surcharge`, falling back to the house setting) and the delivery
 * areas (`activeDeliveryAreas`, which is per kitchen and moves whenever a kitchen
 * is activated or edited). Batch 51's card was drawn by hand in a chat window and
 * listed all five items with no size marking; a size S customer read it as food
 * she had been shorted. Next week is a re-run of this script, not a redraw.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/menu-card.ts [--kitchen <nickname|name|id>]
 *                                                       [--upload] [--week YYYY-MM-DD]
 *
 * Without `--kitchen` it draws the first active kitchen that has a `menu_text`,
 * which is what it always did. Naming one draws that kitchen whether it is
 * active or not — a kitchen cannot be activated until its card exists, because
 * `dapurOptions` needs `menu_image_url`, so the card has to come first.
 *
 * Three things vary per kitchen and are all read, never typed: whether lunch and
 * dinner are different menus (`same_menu_both_meals`), whether size M exists at
 * all (`offers_size_m` — the size strip and the M blocks are simply absent for a
 * kitchen that does not cook it), and which days it delivers (`delivery_days`,
 * printed in the footer). The areas come from that kitchen's own
 * `delivery_areas`, not from the union across active kitchens: a card promising
 * an area this kitchen does not drive to is a delivery we cannot make.
 *
 * Writes .menu-photos/card-<nickname>.png. Without `--upload` nothing leaves the
 * machine; with it the card goes through the same compression and the same
 * storage path as the dashboard form, and that kitchen's `menu_image_url` and
 * `menu_week_start` point at it. `--week` states the Monday the card covers when
 * the day-of-week default would guess wrong. Nothing is sent to a customer.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { logEdit } from "@/lib/audit/log-edit";
import { BRAND as B, FORMER_NAME, lockupSvg } from "@/lib/brand/logo";
import { compressUploadedImage } from "@/lib/images/compress";
import { defaultMenuWeekStart, jakartaDateString } from "@/lib/menu/week";
import { sizeMSurcharge } from "@/lib/orders/size";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { daysLabel } from "@/lib/subcontractors/days";
import { createAdminClient } from "@/lib/supabase/admin";

const DIR = process.env.MENU_PHOTO_DIR ?? ".menu-photos";

type Day = {
  name: string;
  date: string;
  /** The one menu of the day, for a kitchen that cooks the same food at both meals. */
  s: string[];
  /** Set instead of `s` when lunch and dinner are different menus. */
  lunch: string[] | null;
  dinner: string[] | null;
  m: string | null;
  photo: string | null;
  note?: string;
};

function items(rest: string): string[] {
  return rest
    .replace(/\.$/, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseMenu(text: string): {
  batch: string;
  range: string;
  days: Day[];
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // "Batch 53 — 7 s/d 12 September." is Thenie's own numbering. A kitchen with
  // no batch counter writes its own title, so the left half is any text — and
  // may be left out entirely ("7 s/d 13 September 2026."), which is the honest
  // answer for a kitchen that numbers nothing. An invented placeholder there
  // printed "MENU MINGGUAN · MENU REGULER" across the top of the card.
  const head =
    lines[0]?.match(/^(.+?)\s*—\s*(.+)\.$/) ?? lines[0]?.match(/^()(.+)\.$/);
  const days: Day[] = [];
  for (const line of lines.slice(2)) {
    const parts = line.match(/^(\w+) ([^:]+):\s*(.+)$/);
    if (!parts) continue;
    const [, name, date, rest] = parts;
    const m = rest.match(/Tambahan size M:\s*([^.]+)\./);
    const isChef = /Chef recommendation/i.test(rest);
    // A kitchen whose lunch and dinner differ writes both on the day's line.
    const split = rest.match(/^Siang:\s*(.+?)\.\s*Malam:\s*(.+)$/);
    const body = rest.replace(/\s*Tambahan size M:.*$/, "");
    days.push({
      name,
      date,
      s: isChef || split ? [] : items(body),
      lunch: split ? items(split[1]) : null,
      dinner: split ? items(split[2]) : null,
      m: m ? m[1].trim() : null,
      photo: null,
      note: isChef ? "Menu spesial pilihan chef,<br>diumumkan H-1" : undefined,
    });
  }
  return { batch: head?.[1]?.trim() ?? "", range: head?.[2] ?? "", days };
}

// The Katerloka sheet (docs/DESIGN_SYSTEM.md): nasi ground, each day a white
// card, day names in cabai, the size M pill in kunyit and a daun footer.
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1350px;background:${B.nasi};font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:${B.kecap};-webkit-font-smoothing:antialiased}
.wrap{height:100%;display:flex;flex-direction:column}
.head{display:flex;align-items:flex-start;gap:24px;padding:34px 44px 0}
.logo{display:block;margin-bottom:12px}
.htext{flex:1}
.kicker{font-size:15px;letter-spacing:.14em;font-weight:800;color:${B.cabai};text-transform:uppercase}
.batch{font-size:56px;font-weight:800;line-height:1.02;letter-spacing:-.02em;margin-top:4px}
.range{font-size:20px;font-weight:600;margin-top:6px;color:${B.muted}}
.sizes{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:8px;padding-top:10px;font-size:15px;font-weight:600;color:${B.ink2}}
.sz{display:flex;align-items:center;gap:10px}
.sz b{font-size:14px;font-weight:800;border-radius:999px;padding:3px 11px;color:${B.kecap}}
.sz .s{box-shadow:inset 0 0 0 2px ${B.kecap}}
.sz .m{background:${B.kunyit}}
.grid{flex:1;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:auto auto;align-content:space-evenly;gap:16px 16px;padding:18px 44px}
.cell{display:flex;flex-direction:column;align-items:center;text-align:center;background:${B.surface};border-radius:24px;padding:14px 16px 16px}
.photo{width:100%;height:196px;object-fit:contain;object-position:center bottom;filter:drop-shadow(0 12px 14px rgba(28,25,23,.24))}
.day{font-size:28px;font-weight:800;color:${B.cabai};margin-top:6px;line-height:1.1}
.date{font-size:15px;font-weight:600;color:${B.muted};margin-top:2px}
ul{margin-top:8px}
li{list-style:none;font-size:18px;font-weight:600;line-height:1.36;margin-top:3px;color:${B.ink2}}
.mblock{margin-top:12px;width:100%}
.mtag{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.06em;color:${B.kecap};background:${B.kunyit};border-radius:999px;padding:3px 11px}
.mitem{font-size:18px;font-weight:700;margin-top:5px}
.chef{margin-top:14px;font-size:16px;line-height:1.5;font-weight:600;color:${B.ink2}}
.chef .big{display:block;font-size:19px;font-weight:800;color:${B.cabai};margin-bottom:6px}
.foot{background:${B.daun};color:#fff;padding:20px 44px 22px;display:flex;align-items:center;justify-content:space-between;gap:28px}
.areas{font-size:15px;font-weight:700;line-height:1.45;max-width:640px}
.note{font-size:13px;font-weight:600;opacity:.8;margin-top:6px}
.order{text-align:right;flex:none}
.order .lbl{font-size:12px;letter-spacing:.14em;font-weight:800;text-transform:uppercase;opacity:.85}
.order .wa{font-size:28px;font-weight:800;color:${B.kunyit};line-height:1.2}
.order .was{font-size:12px;font-weight:600;opacity:.75}
/* A kitchen with no generated photos gets a written card: the dishes are the
   whole cell, so they get a panel of their own rather than floating under an
   empty photo slot. */
.grid.text{min-height:0;--tfs:21px;--tday:30px;grid-template-columns:repeat(2,1fr);grid-auto-rows:1fr;align-content:stretch;gap:18px}
.grid.text .cell{overflow:hidden;padding:20px 24px;text-align:left;align-items:stretch;justify-content:flex-start}
.grid.text .day{margin-top:0;font-size:var(--tday)}
.grid.text .date{font-size:16px}
.grid.text li{font-size:var(--tfs);line-height:1.36;margin-top:3px}
.grid.text .mealtag{font-size:12px;padding:3px 11px}
.meal{margin-top:11px}
.mealtag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.08em;color:${B.daun};background:${B.daunSoft};border-radius:999px;padding:2px 9px}
.meal ul{margin-top:5px}
`;

/**
 * The S box and the M tambahan are drawn apart, always. Folding them into one
 * list is the bug this card exists to fix.
 */
function cell(d: Day, photos: boolean) {
  if (!d.s.length && !d.lunch && !d.dinner) {
    // The spacer image keeps a chef's-choice cell aligned with its photographed
    // neighbours. On a written card there are no photos to align to, and the
    // reserved height pushed the whole cell past the clip: Santapin's Minggu
    // rendered as an empty box.
    return `<div class="cell">${photos ? '<img class="photo" src="" style="visibility:hidden">' : ""}
      <div class="day">${d.name}</div><div class="date">${d.date}</div>
      <div class="chef"><span class="big">CHEF'S CHOICE</span>${d.note ?? ""}</div></div>`;
  }
  const list = (xs: string[]) =>
    `<ul>${xs.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  const meals =
    d.lunch || d.dinner
      ? `${d.lunch ? `<div class="meal"><span class="mealtag">SIANG</span>${list(d.lunch)}</div>` : ""}
         ${d.dinner ? `<div class="meal"><span class="mealtag">MALAM</span>${list(d.dinner)}</div>` : ""}`
      : list(d.s);
  return `<div class="cell">
    ${d.photo ? `<img class="photo" src="${d.photo}">` : ""}
    <div class="day">${d.name}</div><div class="date">${d.date}</div>
    ${meals}
    ${d.m ? `<div class="mblock"><span class="mtag">+ SIZE M</span><div class="mitem">${d.m}</div></div>` : ""}
  </div>`;
}

function page(
  menu: ReturnType<typeof parseMenu>,
  areas: string[],
  surcharge: number,
  wa: string,
  opts: {
    offersM: boolean;
    daysLine: string;
    photos: boolean;
    nickname: string | null;
  },
) {
  const rp = `Rp ${surcharge.toLocaleString("id-ID")}`;
  const cols = menu.days.length > 6 ? 3 : 2;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="wrap">
    <div class="head">
      <div class="htext">
        <div class="logo">${lockupSvg("light", 52)}</div>
        ${
          // The nickname is the only name of a kitchen a customer may ever see,
          // and with three kitchens offered at once it has to be the biggest
          // thing on the card: three cards whose headline is the kitchen's own
          // title differ only in their dish lists, and a customer cannot ask
          // for one by name. The kitchen's own title — Thenie's batch number —
          // moves up to the kicker, where it is still printed. A kitchen with
          // no nickname keeps the old layout rather than falling back to
          // `name`, which is the supplier's real name and never goes out.
          opts.nickname
            ? `<div class="kicker">Menu Mingguan${menu.batch ? ` · ${menu.batch}` : ""}</div>
               <div class="batch"${
                 // A long nickname at the full 52px runs into the size block
                 // beside it — "DAPUR MONSTERA" left no gap at all. The header
                 // is one row, so the name gives way rather than wrapping.
                 opts.nickname.length > 12 ? ' style="font-size:44px"' : ""
}>${opts.nickname.toUpperCase()}</div>`
            : `<div class="kicker">Menu Mingguan</div>
               <div class="batch">${(menu.batch || "Menu Mingguan").toUpperCase()}</div>`
        }
        <div class="range">${menu.range}</div>
      </div>
      <div class="sizes">
        ${
          opts.offersM
            ? `<div class="sz"><b class="s">S</b>nasi + lauk + sayur + sambal</div>
               <div class="sz"><b class="m">M</b>size S + lauk tambahan (+${rp}/porsi)</div>`
            : '<div class="sz"><b class="s">SATU UKURAN</b>nasi + lauk + sayur + sambal</div>'
        }
      </div>
    </div>
    <div class="grid${opts.photos ? "" : " text"}"${
      opts.photos
        ? ""
        : // The shape is counted from the days, never fixed: Santapin's week is
          // seven days since they cook Minggu. Cell height is what a split-meal
          // card runs out of, so a seventh day buys a third column rather than a
          // fourth row — the same page split four ways clipped every cell and
          // dropped the MALAM half off the card.
          ` style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${Math.ceil(menu.days.length / cols)},1fr)"`
    }>${menu.days.map((d) => cell(d, opts.photos)).join("")}</div>
    <div class="foot">
      <div>
        <div class="areas">${areas.join(" &nbsp;·&nbsp; ")}</div>
        <div class="note">${opts.photos && opts.offersM ? "Foto menampilkan porsi size M · " : ""}${opts.daysLine} · pesanan ditutup 16.00 WIB H-1</div>
      </div>
      <div class="order"><div class="lbl">Pesan via WhatsApp</div><div class="wa">${wa}</div><div class="was">Katerloka · ${FORMER_NAME}</div></div>
    </div>
  </div></body></html>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const wanted = argv[argv.indexOf("--kitchen") + 1];
  const asked = argv.includes("--kitchen") ? (wanted ?? "").trim() : "";
  if (argv.includes("--kitchen") && !asked)
    throw new Error("--kitchen needs a nickname, a name or an id");

  const upload = argv.includes("--upload");
  const statedWeek = argv.includes("--week")
    ? (argv[argv.indexOf("--week") + 1] ?? "").trim()
    : "";
  if (statedWeek && !/^\d{4}-\d{2}-\d{2}$/.test(statedWeek))
    throw new Error("--week needs a Monday as YYYY-MM-DD");
  const weekStart = statedWeek || defaultMenuWeekStart(jakartaDateString());

  const db = createAdminClient();
  const [{ data: kitchens, error }, fallbackAreas] = await Promise.all([
    db
      .from("subcontractors")
      .select(
        "id, name, customer_nickname, menu_text, delivery_areas, delivery_days, offers_size_m, size_m_surcharge, is_active",
      ),
    activeDeliveryAreas(db),
  ]);
  if (error) throw new Error(error.message);
  const all = kitchens ?? [];

  const hasMenu = (k: (typeof all)[number]) =>
    (k.menu_text ?? "").trim().length > 0;
  const needle = asked.toLowerCase();
  const kitchen = asked
    ? all.find(
        (k) =>
          k.id === asked ||
          (k.customer_nickname ?? "").toLowerCase().includes(needle) ||
          k.name.toLowerCase().includes(needle),
      )
    : all.find((k) => k.is_active === true && hasMenu(k));
  if (!kitchen)
    throw new Error(
      asked
        ? `no kitchen matches "${asked}"`
        : "no active kitchen has a menu_text to draw",
    );
  if (!hasMenu(kitchen))
    throw new Error(
      `${kitchen.customer_nickname ?? kitchen.name} has no menu_text — write the week into that column first`,
    );

  const slug = (kitchen.customer_nickname ?? kitchen.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const menu = parseMenu(kitchen.menu_text ?? "");
  // Photos live under the kitchen that cooked them (`.menu-photos/<slug>/`) and
  // only Thenie has any. They were flat files while one kitchen cooked
  // everything, and the first card drawn for a second kitchen put Thenie's five
  // trays under Homey's dish names — the exact "names a dish, shows another"
  // failure this script was written to end. A missing file is drawn as a
  // written card, never as another kitchen's food.
  let photos = false;
  menu.days.forEach((d, i) => {
    const file = `${process.cwd()}/${DIR}/${slug}/t${i + 1}.png`;
    if (d.s.length && existsSync(file)) {
      d.photo = `file://${file}`;
      photos = true;
    }
  });

  // This kitchen's own coverage, not the union across active kitchens: some
  // areas rest on a single kitchen, and a card is read as a promise.
  const own = ((kitchen.delivery_areas as string[] | null) ?? []).filter(
    (a) => a.trim().length > 0,
  );
  const areas = own.length > 0 ? own : fallbackAreas;
  const daysLine = daysLabel(kitchen.delivery_days) || "Senin–Sabtu";
  // This kitchen's own M tambahan, for the same reason as the areas above.
  const surcharge = await sizeMSurcharge(kitchen);

  const html = page(menu, areas, surcharge, "0851-1121-4390", {
    offersM: kitchen.offers_size_m === true,
    daysLine,
    photos,
    nickname: kitchen.customer_nickname,
  });
  writeFileSync(`${DIR}/card-${slug}.html`, html);

  const browser = await chromium.launch();
  const ctx = await browser.newPage({
    viewport: { width: 1080, height: 1350 },
    deviceScaleFactor: 2,
  });
  await ctx.goto(`file://${process.cwd()}/${DIR}/card-${slug}.html`);
  await ctx.waitForTimeout(1500); // Google Fonts, then the photos
  // A written card carries whatever the kitchen cooks that week — six days of
  // separate lunch and dinner is twice the text of five single line-ups — so
  // the type shrinks until the densest cell fits rather than being cut off.
  // `evaluate` gets a string, not a closure: tsx compiles with keepNames, and
  // the injected `__name` helper does not exist inside the page.
  await ctx.evaluate(`
    (function () {
      var grid = document.querySelector(".grid.text");
      if (!grid) return;
      function spills() {
        return Array.prototype.some.call(
          grid.children,
          function (c) { return c.scrollHeight > c.clientHeight; },
        );
      }
      for (var fs = 21; fs > 13 && spills(); fs--) {
        grid.style.setProperty("--tfs", fs - 1 + "px");
        grid.style.setProperty("--tday", Math.max(23, fs + 8) + "px");
      }
    })()
  `);
  await ctx.screenshot({ path: `${DIR}/card-${slug}.png` });
  await browser.close();
  console.log(
    `${DIR}/card-${slug}.png — ${kitchen.customer_nickname ?? kitchen.name}, ${menu.batch}, ${menu.days.length} days`,
  );

  if (!upload) return console.log("Nothing uploaded. Re-run with --upload.");

  // Exactly what the dashboard's Subcontractors → menu image form does
  // (src/app/api/subcontractors/[id]/menu-image/route.ts): the same
  // compression, the same storage path, the same two columns, the same audit
  // row. A card the customer never receives changes nothing, and the upload was
  // a browser-only step — so a week could be rendered and then left on disk.
  const image = await compressUploadedImage(
    readFileSync(`${DIR}/card-${slug}.png`),
  );
  const storagePath = `subcontractors/${kitchen.id}/${Date.now()}.${image.extension}`;
  const { error: upErr } = await db.storage
    .from("menu-images")
    .upload(storagePath, image.buffer, {
      contentType: image.contentType,
      upsert: true,
    });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);
  const url = db.storage.from("menu-images").getPublicUrl(storagePath)
    .data.publicUrl;

  // Which week the image covers is what lets the bot call it "next week's
  // menu"; the day-of-week default is a guess and `--week` is the correction.
  const { error: updErr } = await db
    .from("subcontractors")
    .update({
      menu_image_url: url,
      menu_week_start: weekStart,
      updated_at: new Date().toISOString(),
    })
    .eq("id", kitchen.id);
  if (updErr) throw new Error(updErr.message);

  await logEdit({
    db,
    actor: "script:menu-card",
    entityType: "subcontractors",
    entityId: kitchen.id,
    action: "update",
    changes: { menu_image_url: url, menu_week_start: weekStart },
  });
  console.log(
    `  → menu_image_url = ${url}\n  → menu_week_start = ${weekStart} (${(image.buffer.length / 1024).toFixed(0)} KB)`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
