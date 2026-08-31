/**
 * Renders the personal-package price list (1080×1350, the size WhatsApp wants)
 * that `send_price_list` hands a customer who asks for prices.
 *
 * Every number is read, never typed: the per-portion rates come from
 * `pricing_tiers`, the size M surcharge from `settings.size_m_surcharge`, and
 * the delivery areas from `activeDeliveryAreas()`. The sheet it replaces was
 * drawn by hand and pictured the S box only, so a customer who asked for prices
 * had no way to learn size M existed at all — which is half of what Naya's
 * dispute on 2026-08-31 was about. Next time a rate changes this is a re-run,
 * not a redraw.
 *
 * Size M is drawn under each S price rather than left to the customer to work
 * out, because the surcharge is per *porsi* while the table's rows are labelled
 * in *hari*, and the two differ by 2× in the lunch & dinner column: "20 hari"
 * there is 40 porsi, so M costs +Rp 160.000, not +80.000. A customer doing that
 * sum in their head halves it and quotes themselves a price we then have to
 * correct.
 *
 * M is omitted entirely — rows, legend and all — when no active kitchen has
 * `offers_size_m`, the same way the areas are per kitchen. Printing an M price
 * nobody cooks is worse than printing no M price.
 *
 * Usage: npx tsx --env-file=.env.local scripts/price-list.ts
 * Writes .menu-photos/price-list.png. Nothing is uploaded and nothing is sent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { sizeMSurcharge } from "@/lib/orders/size";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";

const DIR = process.env.MENU_PHOTO_DIR ?? ".menu-photos";
const RED = "#C0181C"; // brand primary, flat — the menu card uses this exact red
const GOLD = "#F7C948";
const CREAM = "#FDF6E7";
const INK = "#2B2B2B";
/** The white-on-transparent master mark; it carries the wordmark, so the sheet prints no brand name of its own. */
const LOGO = `${process.cwd()}/scripts/assets/menu-card-logo.png`;
const WA = "0851-1121-4390";

/**
 * The nasi merah surcharge is the one price on this sheet that is not in the
 * database — it is written into the system prompt (src/lib/claude/prompts/
 * system.ts, "Nasi merah") and into `extract_order`. Change it there and here
 * together, or the sheet quotes one number while the bot charges another.
 */
const NASI_MERAH = 5000;

/** The rows the sheet has always carried, in the order it carried them. */
const GROUPS: { label: string; days: number[] }[] = [
  { label: "Mingguan", days: [6, 5] },
  { label: "Bulanan", days: [24, 20] },
  { label: "3 Bulan", days: [72, 60] },
];

const REQUESTS: { title: string; chips: string[]; note?: string }[] = [
  { title: "Request Protein", chips: ["Tanpa Sapi", "Tanpa Seafood"] },
  { title: "Request Preferensi", chips: ["Tidak Pedas", "Tanpa Nasi"] },
  {
    title: "Request Nasi",
    chips: ["Nasi Merah"],
    note: `+ Rp ${NASI_MERAH.toLocaleString("id-ID")} / porsi`,
  },
];

/**
 * The rate for a portion count, off the ladder.
 *
 * Largest listed size at or below the count, which is the same rule
 * `createOrderFromExtraction` prices a divisible-but-unlisted total by — never
 * the nearest tier, which would round a 20-porsi order up to the 24 rate.
 */
function rateFor(portions: number, tiers: Record<number, number>): number {
  const listed = Object.keys(tiers)
    .map(Number)
    .filter((p) => p <= portions)
    .sort((a, b) => b - a);
  if (!listed.length) throw new Error(`no pricing tier at or below ${portions}`);
  return tiers[listed[0]];
}

/** `540000` → `"540k"`, `1040000` → `"1.040k"` — the notation the sheet has always used. */
function k(total: number): string {
  return `${(total / 1000).toLocaleString("id-ID")}k`;
}

type Price = { total: string; rate: string };

function price(portions: number, perPortion: number): Price {
  return {
    total: k(portions * perPortion),
    rate: `${perPortion / 1000}k/porsi`,
  };
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700;800&family=Nunito:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1350px;background:${RED};font-family:'Nunito',system-ui,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
.wrap{padding:32px 40px 22px;height:100%;display:flex;flex-direction:column}
.head{display:flex;align-items:center;gap:18px}
.logo{width:150px;height:auto;object-fit:contain;flex:none}
.htext{flex:1}
.kicker{font-family:'Poppins';font-size:14px;letter-spacing:.34em;font-weight:600;color:${GOLD};text-transform:uppercase}
.title{font-family:'Poppins';font-size:52px;font-weight:800;line-height:1.02;margin-top:2px}
.sub{font-family:'Poppins';font-size:20px;font-weight:500;margin-top:4px;opacity:.92}
.sizes{flex:none;text-align:right;font-family:'Poppins';font-size:14px;font-weight:500;line-height:1.65;opacity:.95}
.sizes b{color:${GOLD};font-weight:700}
.rule{height:2px;background:${GOLD};opacity:.55;margin:18px 0 16px}

table{width:100%;border-collapse:separate;border-spacing:0 7px}
th{font-family:'Poppins';font-size:19px;font-weight:700;color:${INK};background:#fff;padding:11px 10px;border-radius:12px;text-transform:uppercase;letter-spacing:.02em}
th.pk{width:31%}
.grp td{padding:8px 0 1px}
.grp span{font-family:'Poppins';font-size:13px;font-weight:700;letter-spacing:.26em;color:${GOLD};text-transform:uppercase}
td.paket{background:#fff;color:${INK};font-family:'Poppins';font-size:27px;font-weight:800;text-align:center;border-radius:12px;padding:11px 8px}
td.pc{background:${GOLD};color:${INK};border-radius:12px;padding:8px 16px 7px;width:34.5%}
.s{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.s .amt{font-family:'Poppins';font-size:38px;font-weight:800;line-height:1.05}
.s .rate{font-family:'Poppins';font-size:14px;font-weight:700;opacity:.72}
.m{display:flex;align-items:center;gap:8px;margin-top:5px;padding-top:5px;border-top:1.5px solid rgba(43,43,43,.22)}
.m .chip{font-family:'Poppins';font-size:11px;font-weight:800;letter-spacing:.06em;color:${GOLD};background:${INK};border-radius:999px;padding:2px 8px;flex:none}
.m .amt{font-family:'Poppins';font-size:21px;font-weight:700;opacity:.86}
.m .rate{font-family:'Poppins';font-size:13px;font-weight:700;opacity:.6;margin-left:auto}

.reqhead{font-family:'Poppins';font-size:13px;letter-spacing:.26em;font-weight:700;color:${GOLD};text-transform:uppercase;text-align:center;margin-top:15px}
.reqs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:10px}
.req{background:${CREAM};border-radius:14px;padding:11px 14px 12px;text-align:center}
.req .rt{font-family:'Poppins';font-size:17px;font-weight:800;color:${INK}}
.req .rs{font-size:11px;font-weight:700;color:${INK};opacity:.55;letter-spacing:.08em;text-transform:uppercase;margin-top:1px}
.chips{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.chip2{background:${RED};color:#fff;border-radius:999px;font-family:'Poppins';font-size:16px;font-weight:700;padding:7px 6px}
.req .rn{font-size:13px;font-weight:700;color:${INK};opacity:.7;margin-top:8px}

.foot{margin-top:auto;border-top:2px solid ${GOLD}8c;padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.areas{font-size:15px;font-weight:700;line-height:1.45;opacity:.95;max-width:620px}
.order{text-align:right;flex:none}
.order .lbl{font-family:'Poppins';font-size:12px;letter-spacing:.2em;font-weight:600;color:${GOLD};text-transform:uppercase}
.order .wa{font-family:'Poppins';font-size:26px;font-weight:800;letter-spacing:.02em;line-height:1.15}
.note{text-align:center;font-size:13px;font-weight:600;opacity:.8;margin-top:8px}
`;

/** The S price is the cell; M sits under it, smaller, so it reads as an option and not a competing number. */
function cell(s: Price, m: Price | null) {
  return `<td class="pc">
    <div class="s"><span class="amt">${s.total}</span><span class="rate">${s.rate}</span></div>
    ${m ? `<div class="m"><span class="chip">M</span><span class="amt">${m.total}</span><span class="rate">${m.rate}</span></div>` : ""}
  </td>`;
}

function page(
  tiers: Record<number, number>,
  surcharge: number,
  areas: string[],
) {
  const rows = GROUPS.map((g) => {
    const days = g.days
      .map((d) => {
        const single = rateFor(d, tiers);
        const both = rateFor(d * 2, tiers);
        return `<tr>
          <td class="paket">${d} HARI</td>
          ${cell(price(d, single), surcharge ? price(d, single + surcharge) : null)}
          ${cell(price(d * 2, both), surcharge ? price(d * 2, both + surcharge) : null)}
        </tr>`;
      })
      .join("");
    return `<tr class="grp"><td colspan="3"><span>${g.label}</span></td></tr>${days}`;
  }).join("");

  const reqs = REQUESTS.map(
    (r) => `<div class="req">
      <div class="rt">${r.title}</div><div class="rs">Max. pilih 1</div>
      <div class="chips">${r.chips.map((c) => `<div class="chip2">${c}</div>`).join("")}</div>
      ${r.note ? `<div class="rn">${r.note}</div>` : ""}
    </div>`,
  ).join("");

  const rp = `Rp ${surcharge.toLocaleString("id-ID")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="wrap">
    <div class="head">
      <img class="logo" src="file://${LOGO}">
      <div class="htext">
        <div class="kicker">Daftar Harga</div>
        <div class="title">PAKET PERSONAL</div>
        <div class="sub">Halal · Gratis ongkir · Senin–Sabtu</div>
      </div>
      <div class="sizes">
        <div><b>SIZE S</b> — nasi + lauk + sayur + sambal</div>
        ${surcharge ? `<div><b>SIZE M</b> — size S + lauk tambahan (+${rp}/porsi)</div>` : ""}
      </div>
    </div>
    <div class="rule"></div>
    <table>
      <tr><th class="pk">Paket Personal</th><th>Lunch <i>atau</i> Dinner</th><th>Lunch &amp; Dinner</th></tr>
      ${rows}
    </table>
    <div class="reqhead">Request Catering — Gratis</div>
    <div class="reqs">${reqs}</div>
    <div class="foot">
      <div class="areas">${areas.join(" &nbsp;·&nbsp; ")}</div>
      <div class="order"><div class="lbl">Pesan via WhatsApp</div><div class="wa">${WA}</div></div>
    </div>
    <div class="note">Harga sudah termasuk ongkir · pesanan &amp; perubahan ditutup 16.00 WIB H-1</div>
  </div></body></html>`;
}

async function main() {
  const db = createAdminClient();
  const [{ data: tierRows, error }, { data: kitchens }, areas, surcharge] =
    await Promise.all([
      db.from("pricing_tiers").select("portions, price_per_portion"),
      db.from("subcontractors").select("offers_size_m").eq("is_active", true),
      activeDeliveryAreas(db),
      sizeMSurcharge(),
    ]);
  if (error) throw new Error(error.message);
  if (!tierRows?.length) throw new Error("pricing_tiers is empty");

  const tiers: Record<number, number> = {};
  for (const t of tierRows) tiers[t.portions] = t.price_per_portion;

  // Coverage is per kitchen, so the sheet only advertises M while a kitchen
  // that cooks it is actually taking orders.
  const offersM = (kitchens ?? []).some((s) => s.offers_size_m);
  const m = offersM ? surcharge : 0;

  mkdirSync(DIR, { recursive: true });
  const html = page(tiers, m, areas);
  writeFileSync(`${DIR}/price-list.html`, html);

  const browser = await chromium.launch();
  const ctx = await browser.newPage({
    viewport: { width: 1080, height: 1350 },
    deviceScaleFactor: 2,
  });
  await ctx.goto(`file://${process.cwd()}/${DIR}/price-list.html`);
  await ctx.waitForTimeout(1500); // Google Fonts
  await ctx.screenshot({ path: `${DIR}/price-list.png` });
  await browser.close();
  console.log(
    `${DIR}/price-list.png — ${GROUPS.reduce((n, g) => n + g.days.length, 0)} rows, size M ${m ? `on (+${m})` : "off (no active kitchen cooks it)"}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
