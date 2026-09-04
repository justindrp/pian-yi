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
 * One sheet per active kitchen, because the customer picks their kitchen and
 * is shown that kitchen's prices: its own ladder, its own delivery areas, its
 * own delivery days, its own size M. With no active kitchen there is still the
 * house sheet, which is what `settings.price_list_image_url` holds.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/price-list.ts [--all] [--upload]
 * Writes .menu-photos/price-list-<dapur>.png. Without --upload nothing leaves
 * the machine; with it each sheet lands in the `menu` bucket and its URL in
 * that kitchen's `price_list_image_url` (or the setting, for the house sheet).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { sizeMSurcharge } from "@/lib/orders/size";
import { tiersForKitchen } from "@/lib/pricing/tiers";
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
  if (!listed.length)
    throw new Error(`no pricing tier at or below ${portions}`);
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

/**
 * "Senin–Sabtu" from `subcontractors.delivery_days`.
 *
 * The sheet used to print Senin–Sabtu as a fact about the business, which it
 * was while Thenie cooked everything. Dapur Monstera works Senin–Jumat, so a
 * sheet of theirs carrying Sabtu advertises a day nobody cooks. A contiguous
 * run prints as a span, anything else as a list.
 */
const WEEKDAY = [
  "",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
  "Minggu",
];

function daysLabelFor(days: number[]): string {
  const sorted = [...new Set(days)]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (sorted.length === 1) return WEEKDAY[sorted[0]];
  return contiguous
    ? `${WEEKDAY[sorted[0]]}–${WEEKDAY[sorted[sorted.length - 1]]}`
    : sorted.map((d) => WEEKDAY[d]).join(", ");
}

function page(
  tiers: Record<number, number>,
  surcharge: number,
  areas: string[],
  nickname: string | null,
  daysLabel: string,
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

  // An M cell carries two prices and an S-only cell one, so a sheet without M
  // is a third shorter than the page and `.foot`'s `margin-top:auto` parks the
  // footer at the bottom with a red hole above it. Every kitchen but Thenie is
  // S only, so that hole is the normal case now, not the exception. The rows
  // take the slack instead of the gap.
  const fill = surcharge
    ? ""
    : "td.paket{padding:31px 8px}td.pc{padding:28px 16px 27px}";

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${fill}</style></head><body>
  <div class="wrap">
    <div class="head">
      <img class="logo" src="file://${LOGO}">
      <div class="htext">
        <div class="kicker">Daftar Harga${nickname ? ` · ${nickname}` : ""}</div>
        <div class="title">PAKET PERSONAL</div>
        <div class="sub">Halal · Gratis ongkir · ${daysLabel}</div>
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
  const upload = process.argv.includes("--upload");
  // A sheet has to be looked at before its kitchen goes live, and the kitchen
  // is not active until it has been. `--all` renders the inactive ones too;
  // combined with --upload it publishes them, which is how a kitchen arrives
  // with its sheet already on file.
  const includeInactive = process.argv.includes("--all");
  const db = createAdminClient();

  const [{ data: kitchens, error: kErr }, surcharge] = await Promise.all([
    db
      .from("subcontractors")
      .select(
        "id, customer_nickname, is_active, offers_size_m, delivery_areas, delivery_days",
      )
      .order("customer_nickname"),
    sizeMSurcharge(),
  ]);
  if (kErr) throw new Error(kErr.message);
  const wanted = (kitchens ?? []).filter((k) => includeInactive || k.is_active);

  // One sheet per active kitchen, because the customer picks their kitchen and
  // is shown that kitchen's prices. Everything on a sheet is that kitchen's
  // own: its ladder (`tiersForKitchen`, falling back to the house one), its
  // `delivery_areas` rather than the union, its `offers_size_m`, its
  // `delivery_days`. With no active kitchen at all there is still the house
  // sheet, which is what `settings.price_list_image_url` holds.
  const sheets: {
    id: string | null;
    nickname: string | null;
    areas: string[];
    offersM: boolean;
    days: number[];
  }[] =
    wanted.length > 0
      ? wanted.map((k) => ({
          id: k.id,
          nickname: k.customer_nickname,
          areas: (k.delivery_areas as string[] | null) ?? [],
          offersM: !!k.offers_size_m,
          days: k.delivery_days ?? [1, 2, 3, 4, 5, 6],
        }))
      : [
          {
            id: null,
            nickname: null,
            areas: await activeDeliveryAreas(db),
            offersM: false,
            days: [1, 2, 3, 4, 5, 6],
          },
        ];

  mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const sheet of sheets) {
    const tierRows = await tiersForKitchen(db, sheet.id);
    if (tierRows.length === 0)
      throw new Error(`no pricing tier for ${sheet.nickname ?? "house"}`);
    const tiers: Record<number, number> = {};
    for (const t of tierRows) tiers[t.portions] = t.price_per_portion;

    const m = sheet.offersM ? surcharge : 0;
    const slug = (sheet.nickname ?? "house")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const base = `${DIR}/price-list-${slug}`;

    const html = page(
      tiers,
      m,
      sheet.areas,
      sheet.nickname,
      daysLabelFor(sheet.days),
    );
    writeFileSync(`${base}.html`, html);

    const ctx = await browser.newPage({
      viewport: { width: 1080, height: 1350 },
      deviceScaleFactor: 2,
    });
    await ctx.goto(`file://${process.cwd()}/${base}.html`);
    await ctx.waitForTimeout(1500); // Google Fonts
    await ctx.screenshot({ path: `${base}.png` });
    await ctx.close();

    console.log(
      `${base}.png — ${sheet.nickname ?? "house ladder"}, ${daysLabelFor(sheet.days)}, size M ${m ? `on (+${m})` : "off"}`,
    );

    if (upload) {
      const storagePath = `price-list-${slug}-${Date.now()}.png`;
      const { error: upErr } = await db.storage
        .from("menu")
        .upload(storagePath, readFileSync(`${base}.png`), {
          contentType: "image/png",
          upsert: true,
        });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);
      const url = db.storage.from("menu").getPublicUrl(storagePath)
        .data.publicUrl;

      if (sheet.id) {
        const { error } = await db
          .from("subcontractors")
          .update({ price_list_image_url: url })
          .eq("id", sheet.id);
        if (error) throw new Error(error.message);
        console.log(`  → subcontractors.price_list_image_url = ${url}`);
      } else {
        const { error } = await db
          .from("settings")
          .upsert(
            { key: "price_list_image_url", value: url },
            { onConflict: "key" },
          );
        if (error) throw new Error(error.message);
        console.log(`  → settings.price_list_image_url = ${url}`);
      }
    }
  }

  await browser.close();
  if (!upload)
    console.log("Nothing uploaded. Re-run with --upload to publish.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
