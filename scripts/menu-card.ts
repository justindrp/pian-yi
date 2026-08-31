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
 * Usage: npx tsx --env-file=.env.local scripts/menu-card.ts
 * Writes .menu-photos/card.png. Nothing is uploaded and nothing is sent.
 */

import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { sizeMSurcharge } from "@/lib/orders/size";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";

const DIR = process.env.MENU_PHOTO_DIR ?? ".menu-photos";
const RED = "#C0181C"; // brand primary, flat — no gradient, so every red pixel is exactly this
const GOLD = "#F7C948";
/** The white-on-transparent master mark; it carries the wordmark, so the card prints no brand name of its own. */
const LOGO = `${process.cwd()}/scripts/assets/menu-card-logo.png`;

type Day = {
  name: string;
  date: string;
  s: string[];
  m: string | null;
  photo: string | null;
  note?: string;
};

function parseMenu(text: string): {
  batch: string;
  range: string;
  days: Day[];
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines[0]?.match(/^(Batch \d+)\s*—\s*(.+)\.$/);
  const days: Day[] = [];
  for (const line of lines.slice(2)) {
    const parts = line.match(/^(\w+) ([^:]+):\s*(.+)$/);
    if (!parts) continue;
    const [, name, date, rest] = parts;
    const m = rest.match(/Tambahan size M:\s*([^.]+)\./);
    const isChef = /Chef recommendation/i.test(rest);
    days.push({
      name,
      date,
      s: isChef
        ? []
        : rest
            .replace(/\s*Tambahan size M:.*$/, "")
            .replace(/\.$/, "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
      m: m ? m[1].trim() : null,
      photo: null,
      note: isChef ? "Menu spesial pilihan chef,<br>diumumkan H-1" : undefined,
    });
  }
  return { batch: head?.[1] ?? "Batch", range: head?.[2] ?? "", days };
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
`;

/**
 * The S box and the M tambahan are drawn apart, always. Folding them into one
 * list is the bug this card exists to fix.
 */
function cell(d: Day) {
  if (!d.s.length) {
    return `<div class="cell"><img class="photo" src="" style="visibility:hidden">
      <div class="day">${d.name}</div><div class="date">${d.date}</div>
      <div class="chef"><span class="big">CHEF'S CHOICE</span>${d.note ?? ""}</div></div>`;
  }
  return `<div class="cell">
    ${d.photo ? `<img class="photo" src="${d.photo}">` : ""}
    <div class="day">${d.name}</div><div class="date">${d.date}</div>
    <ul>${d.s.map((i) => `<li>${i}</li>`).join("")}</ul>
    ${d.m ? `<div class="mblock"><span class="mtag">+ SIZE M</span><div class="mitem">${d.m}</div></div>` : ""}
  </div>`;
}

function page(
  menu: ReturnType<typeof parseMenu>,
  areas: string[],
  surcharge: number,
  wa: string,
) {
  const rp = `Rp ${surcharge.toLocaleString("id-ID")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="wrap">
    <div class="head">
      <img class="logo" src="file://${LOGO}">
      <div class="htext">
        <div class="kicker">Menu Mingguan</div>
        <div class="batch">${menu.batch.toUpperCase()}</div>
        <div class="range">${menu.range}</div>
      </div>
      <div class="sizes">
        <div><b>SIZE S</b> — nasi + lauk + sayur + sambal</div>
        <div><b>SIZE M</b> — size S + lauk tambahan (+${rp}/porsi)</div>
      </div>
    </div>
    <div class="rule"></div>
    <div class="grid">${menu.days.map(cell).join("")}</div>
    <div class="foot">
      <div class="areas">${areas.join(" &nbsp;·&nbsp; ")}</div>
      <div class="order"><div class="lbl">Pesan via WhatsApp</div><div class="wa">${wa}</div></div>
    </div>
    <div class="note">Foto menampilkan porsi size M · Senin–Sabtu · pesanan ditutup 16.00 WIB H-1</div>
  </div></body></html>`;
}

async function main() {
  const db = createAdminClient();
  const [{ data: kitchens, error }, areas, surcharge] = await Promise.all([
    db
      .from("subcontractors")
      .select("customer_nickname, menu_text")
      .eq("is_active", true),
    activeDeliveryAreas(db),
    sizeMSurcharge(),
  ]);
  if (error) throw new Error(error.message);

  const kitchen = (kitchens ?? []).find(
    (k) => (k.menu_text ?? "").trim().length > 0,
  );
  if (!kitchen) throw new Error("no active kitchen has a menu_text to draw");

  const menu = parseMenu(kitchen.menu_text ?? "");
  menu.days.forEach((d, i) => {
    if (d.s.length) d.photo = `file://${process.cwd()}/${DIR}/t${i + 1}.png`;
  });

  const html = page(menu, areas, surcharge, "0851-1121-4390");
  writeFileSync(`${DIR}/card.html`, html);

  const browser = await chromium.launch();
  const ctx = await browser.newPage({
    viewport: { width: 1080, height: 1350 },
    deviceScaleFactor: 2,
  });
  await ctx.goto(`file://${process.cwd()}/${DIR}/card.html`);
  await ctx.waitForTimeout(1500); // Google Fonts, then the photos
  await ctx.screenshot({ path: `${DIR}/card.png` });
  await browser.close();
  console.log(`${DIR}/card.png — ${menu.batch}, ${menu.days.length} days`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
