/**
 * Renders the weekly menu card (1080×1350, the size WhatsApp and Instagram want)
 * from `subcontractors.menu_text` plus the photos scripts/menu-photos.ts wrote.
 *
 * Every string on the card is read, never typed: the batch and dates, the dishes,
 * the size M item, the surcharge (`settings.size_m_surcharge`) and the delivery
 * areas (`activeDeliveryAreas`, which is per kitchen and moves whenever a kitchen
 * is activated or edited). Batch 51's card was drawn by hand in a chat window and
 * listed all five items with no size marking; a size S customer read it as food
 * she had been shorted. Next week is a re-run of this script, not a redraw.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/menu-card.ts [--kitchen <nickname|name|id>]
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
 * Writes .menu-photos/card-<nickname>.png. Nothing is uploaded and nothing is sent.
 */

import { existsSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { sizeMSurcharge } from "@/lib/orders/size";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { daysLabel } from "@/lib/subcontractors/days";
import { createAdminClient } from "@/lib/supabase/admin";

const DIR = process.env.MENU_PHOTO_DIR ?? ".menu-photos";
const RED = "#C0181C"; // brand primary, flat — no gradient, so every red pixel is exactly this
const GOLD = "#F7C948";
/** The white-on-transparent master mark; it carries the wordmark, so the card prints no brand name of its own. */
const LOGO = `${process.cwd()}/scripts/assets/menu-card-logo.png`;

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

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700;800&family=Nunito:wght@400;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1350px;background:${RED};font-family:'Nunito',system-ui,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
.wrap{padding:34px 40px 26px;height:100%;display:flex;flex-direction:column}
.head{display:flex;align-items:center;gap:18px}
.logo{width:150px;height:auto;object-fit:contain;flex:none}
.htext{flex:1}
.kicker{font-family:'Poppins';font-size:14px;letter-spacing:.34em;font-weight:600;color:${GOLD};text-transform:uppercase}
.batch{font-family:'Poppins';font-size:52px;font-weight:800;line-height:1.02;margin-top:2px}
.range{font-family:'Poppins';font-size:20px;font-weight:500;margin-top:4px;opacity:.92}
.sizes{flex:none;text-align:right;font-family:'Poppins';font-size:14px;font-weight:500;line-height:1.65;opacity:.95}
.sizes b{color:${GOLD};font-weight:700}
.rule{height:2px;background:${GOLD};opacity:.55;margin:18px 0 16px}
.grid{flex:1;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:auto auto;align-content:space-evenly;gap:18px 14px}
.cell{display:flex;flex-direction:column;align-items:center;text-align:center}
.photo{width:100%;height:265px;object-fit:contain;object-position:center bottom;filter:drop-shadow(0 10px 14px rgba(0,0,0,.32))}
.day{font-family:'Poppins';font-size:26px;font-weight:800;color:${GOLD};letter-spacing:.03em;text-transform:uppercase;margin-top:6px;line-height:1.1}
.date{font-family:'Poppins';font-size:14px;font-weight:500;opacity:.85;margin-top:1px}
ul{margin-top:9px}
li{list-style:none;font-size:18px;font-weight:600;line-height:1.36;margin-top:3px}
.mblock{margin-top:13px;width:100%}
.mtag{display:inline-block;font-family:'Poppins';font-size:11px;font-weight:700;letter-spacing:.06em;color:#2B2B2B;background:${GOLD};border-radius:999px;padding:3px 10px}
.mitem{font-size:18px;font-weight:700;margin-top:5px}
.chef{margin-top:14px;font-size:16px;line-height:1.5;font-weight:600;opacity:.92}
.chef .big{font-family:'Poppins';display:block;font-size:19px;font-weight:700;color:${GOLD};margin-bottom:6px}
.foot{margin-top:18px;border-top:2px solid ${GOLD}8c;padding-top:14px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.areas{font-size:15px;font-weight:700;line-height:1.45;opacity:.95;max-width:620px}
.order{text-align:right;flex:none}
.order .lbl{font-family:'Poppins';font-size:12px;letter-spacing:.2em;font-weight:600;color:${GOLD};text-transform:uppercase}
.order .wa{font-family:'Poppins';font-size:26px;font-weight:800;letter-spacing:.02em;line-height:1.15}
.note{text-align:center;font-size:13px;font-weight:600;opacity:.8;margin-top:9px}
/* A kitchen with no generated photos gets a written card: the dishes are the
   whole cell, so they get a panel of their own rather than floating under an
   empty photo slot. */
.grid.text{min-height:0;--tfs:21px;--tday:30px;grid-template-columns:repeat(2,1fr);grid-auto-rows:1fr;align-content:stretch;gap:20px}
.grid.text .cell{overflow:hidden;background:rgba(255,255,255,.08);border:2px solid ${GOLD}55;border-radius:20px;padding:20px 22px;text-align:left;align-items:stretch;justify-content:flex-start}
.grid.text .day{margin-top:0;font-size:var(--tday)}
.grid.text .date{font-size:16px}
.grid.text li{font-size:var(--tfs);line-height:1.36;margin-top:3px}
.grid.text .mealtag{font-size:12px;padding:3px 11px}
.meal{margin-top:11px}
.mealtag{display:inline-block;font-family:'Poppins';font-size:11px;font-weight:700;letter-spacing:.08em;color:#2B2B2B;background:${GOLD};border-radius:999px;padding:2px 9px}
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
      <img class="logo" src="file://${LOGO}">
      <div class="htext">
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
            ? `<div><b>SIZE S</b> — nasi + lauk + sayur + sambal</div>
               <div><b>SIZE M</b> — size S + lauk tambahan (+${rp}/porsi)</div>`
            : "<div><b>SATU UKURAN</b> — nasi + lauk + sayur + sambal</div>"
        }
      </div>
    </div>
    <div class="rule"></div>
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
      <div class="areas">${areas.join(" &nbsp;·&nbsp; ")}</div>
      <div class="order"><div class="lbl">Pesan via WhatsApp</div><div class="wa">${wa}</div></div>
    </div>
    <div class="note">${opts.photos && opts.offersM ? "Foto menampilkan porsi size M · " : ""}${opts.daysLine} · pesanan ditutup 16.00 WIB H-1</div>
  </div></body></html>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const wanted = argv[argv.indexOf("--kitchen") + 1];
  const asked = argv.includes("--kitchen") ? (wanted ?? "").trim() : "";
  if (argv.includes("--kitchen") && !asked)
    throw new Error("--kitchen needs a nickname, a name or an id");

  const db = createAdminClient();
  const [{ data: kitchens, error }, fallbackAreas, surcharge] =
    await Promise.all([
      db
        .from("subcontractors")
        .select(
          "id, name, customer_nickname, menu_text, delivery_areas, delivery_days, offers_size_m, is_active",
        ),
      activeDeliveryAreas(db),
      sizeMSurcharge(),
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
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
