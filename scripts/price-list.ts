/**
 * Renders the personal-package price list (1080×1350, the size WhatsApp wants)
 * that `send_price_list` hands a customer who asks for prices.
 *
 * Every number is read, never typed: the per-portion rates come from
 * `pricing_tiers`, that kitchen's own size M surcharge
 * (`subcontractors.size_m_surcharge`, falling back to the global setting), and
 * the delivery areas from that kitchen's `delivery_areas`. The sheet it
 * replaces was drawn by hand and pictured the S box only, so a customer who asked for prices
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
 * own delivery days, its own size M. There is no house sheet: the house ladder
 * it was drawn from was Thenie's, and migration 135 moved it onto her.
 * A kitchen with no ladder throws rather than render an empty sheet.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/price-list.ts [--all]
 *                                          [--kitchen <nickname|id>] [--upload]
 * Writes .menu-photos/price-list-<dapur>.png. Without --upload nothing leaves
 * the machine; with it each sheet lands in the `menu` bucket and its URL in
 * that kitchen's `price_list_image_url`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BRAND as B, FORMER_NAME, lockupSvg } from "@/lib/brand/logo";
import { sizeMSurcharge } from "@/lib/orders/size";
import { tiersForKitchen } from "@/lib/pricing/tiers";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { daysLabel } from "@/lib/subcontractors/days";
import { createAdminClient } from "@/lib/supabase/admin";

const DIR = process.env.MENU_PHOTO_DIR ?? ".menu-photos";
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

/** `540000` → `"540.000"`. The sheet prints `Rp` smaller in front, so the figures line up. */
function rp(n: number): string {
  return n.toLocaleString("id-ID");
}

type Price = { total: string; rate: string };

function price(portions: number, perPortion: number): Price {
  return {
    total: rp(portions * perPortion),
    rate: `Rp ${rp(perPortion)}/porsi`,
  };
}

// The Katerloka sheet (docs/DESIGN_SYSTEM.md), the menu card's twin: nasi
// ground, white price cells, the M line behind a kunyit chip, a daun footer.
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1350px;background:${B.nasi};font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:${B.kecap};-webkit-font-smoothing:antialiased}
.wrap{height:100%;display:flex;flex-direction:column}
.main{padding:34px 44px 0;display:flex;flex-direction:column;flex:1}
.head{display:flex;align-items:flex-start;gap:24px}
.logo{display:block;margin-bottom:12px}
.htext{flex:1}
.kicker{font-size:15px;letter-spacing:.14em;font-weight:800;color:${B.cabai};text-transform:uppercase}
.title{font-size:52px;font-weight:800;line-height:1.02;letter-spacing:-.02em;margin-top:4px}
.sub{font-size:19px;font-weight:600;margin-top:6px;color:${B.muted}}
.sizes{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:8px;padding-top:10px;font-size:15px;font-weight:600;color:${B.ink2}}
.sz{display:flex;align-items:center;gap:10px}
.sz b{font-size:14px;font-weight:800;border-radius:999px;padding:3px 11px;color:${B.kecap}}
.sz .s{box-shadow:inset 0 0 0 2px ${B.kecap}}
.sz .m{background:${B.kunyit}}

table{width:100%;border-collapse:separate;border-spacing:8px 7px;margin:12px -8px 0;width:calc(100% + 16px)}
th{font-size:15px;font-weight:800;color:${B.muted};padding:4px 10px 0;text-transform:uppercase;letter-spacing:.1em;text-align:left}
th.pk{width:26%}
.grp td{padding:10px 0 0}
.grp span{font-size:13px;font-weight:800;letter-spacing:.14em;color:${B.cabai};text-transform:uppercase}
td.paket{background:${B.surface};font-size:26px;font-weight:800;border-radius:18px;padding:17px 20px}
td.pc{background:${B.surface};border-radius:18px;padding:15px 20px 14px;width:37%}
.s{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cur{font-size:.5em;font-weight:700;margin-right:4px;color:${B.muted}}
.s .amt{font-size:34px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.s .rate{font-size:13px;font-weight:600;color:${B.muted}}
.m{display:flex;align-items:center;gap:8px;margin-top:5px;padding-top:6px;border-top:1px solid ${B.line}}
.m .chip{font-size:11px;font-weight:800;letter-spacing:.06em;color:${B.kecap};background:${B.kunyit};border-radius:999px;padding:2px 9px;flex:none}
.m .amt{font-size:20px;font-weight:700;color:${B.ink2};font-variant-numeric:tabular-nums}
.m .rate{font-size:12px;font-weight:600;color:${B.muted};margin-left:auto}

.reqhead{font-size:13px;letter-spacing:.14em;font-weight:800;color:${B.cabai};text-transform:uppercase;text-align:center;margin-top:14px}
.reqs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:10px}
.req{background:${B.surface};border-radius:18px;padding:12px 14px 13px;text-align:center}
.req .rt{font-size:17px;font-weight:800}
.req .rs{font-size:11px;font-weight:700;color:${B.muted};letter-spacing:.08em;text-transform:uppercase;margin-top:1px}
.chips{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.chip2{background:${B.cabaiSoft};color:${B.cabaiDeep};border-radius:999px;font-size:15px;font-weight:700;padding:7px 6px}
.req .rn{font-size:13px;font-weight:600;color:${B.muted};margin-top:8px}

.foot{margin-top:auto;background:${B.daun};color:#fff;padding:20px 44px 22px;display:flex;align-items:center;justify-content:space-between;gap:28px}
.areas{font-size:15px;font-weight:700;line-height:1.45;max-width:640px}
.note{font-size:13px;font-weight:600;opacity:.8;margin-top:6px}
.order{text-align:right;flex:none}
.order .lbl{font-size:12px;letter-spacing:.14em;font-weight:800;text-transform:uppercase;opacity:.85}
.order .wa{font-size:28px;font-weight:800;color:${B.kunyit};line-height:1.2}
.order .was{font-size:12px;font-weight:600;opacity:.75}
`;

/** The S price is the cell; M sits under it, smaller, so it reads as an option and not a competing number. */
function cell(s: Price, m: Price | null) {
  return `<td class="pc">
    <div class="s"><span class="amt"><span class="cur">Rp</span>${s.total}</span><span class="rate">${s.rate}</span></div>
    ${m ? `<div class="m"><span class="chip">M</span><span class="amt"><span class="cur">Rp</span>${m.total}</span><span class="rate">${m.rate}</span></div>` : ""}
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

function page(
  tiers: Record<number, number>,
  surcharge: number,
  areas: string[],
  nickname: string | null,
  daysText: string,
  ongkir: { sub: string; note: string },
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

  const mRp = `Rp ${rp(surcharge)}`;

  // An M cell carries two prices and an S-only cell one, so a sheet without M
  // is a third shorter than the page and `.foot`'s `margin-top:auto` parks the
  // footer at the bottom with an empty band above it. Every kitchen but Thenie is
  // S only, so that hole is the normal case now, not the exception. The rows
  // take the slack instead of the gap.
  const fill = surcharge
    ? ""
    : "td.paket{padding:35px 20px}td.pc{padding:33px 20px 32px}";

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${fill}</style></head><body>
  <div class="wrap"><div class="main">
    <div class="head">
      <div class="htext">
        <div class="logo">${lockupSvg("light", 52)}</div>
        <div class="kicker">Daftar Harga${nickname ? ` · ${nickname}` : ""}</div>
        <div class="title">PAKET PERSONAL</div>
        <div class="sub">${["Halal", ongkir.sub, daysText].filter(Boolean).join(" · ")}</div>
      </div>
      <div class="sizes">
        <div class="sz"><b class="s">S</b>nasi + lauk + sayur + sambal</div>
        ${surcharge ? `<div class="sz"><b class="m">M</b>size S + lauk tambahan (+${mRp}/porsi)</div>` : ""}
      </div>
    </div>
    <table>
      <tr><th class="pk">Paket Personal</th><th>Lunch <i>atau</i> Dinner</th><th>Lunch &amp; Dinner</th></tr>
      ${rows}
    </table>
    <div class="reqhead">Request Catering — Gratis</div>
    <div class="reqs">${reqs}</div>
    </div>
    <div class="foot">
      <div>
        <div class="areas">${areas.join(" &nbsp;·&nbsp; ")}</div>
        <div class="note">${ongkir.note} · pesanan &amp; perubahan ditutup 16.00 WIB H-1</div>
      </div>
      <div class="order"><div class="lbl">Pesan via WhatsApp</div><div class="wa">${WA}</div><div class="was">Katerloka · ${FORMER_NAME}</div></div>
    </div>
  </div></body></html>`;
}

async function main() {
  const upload = process.argv.includes("--upload");
  // A sheet has to be looked at before its kitchen goes live, and the kitchen
  // is not active until it has been. `--all` renders the inactive ones too;
  // combined with --upload it publishes them, which is how a kitchen arrives
  // with its sheet already on file.
  const includeInactive = process.argv.includes("--all");
  // `--kitchen` narrows that to one, the same spelling menu-card.ts takes. The
  // pair `--all --upload` publishes every prospect's sheet as well, and a
  // prospect with no `pricing_tiers` rows stops the run — write its ladder
  // first. Naming the kitchen renders one sheet.
  const argv = process.argv.slice(2);
  const wantedName = argv[argv.indexOf("--kitchen") + 1];
  const asked = argv.includes("--kitchen") ? (wantedName ?? "").trim() : "";
  if (argv.includes("--kitchen") && !asked)
    throw new Error("--kitchen needs a nickname or an id");
  const db = createAdminClient();

  const { data: kitchens, error: kErr } = await db
    .from("subcontractors")
    .select(
      "id, customer_nickname, is_active, offers_size_m, size_m_surcharge, delivery_areas, delivery_days",
    )
    .order("customer_nickname");
  if (kErr) throw new Error(kErr.message);
  const needle = asked.toLowerCase();
  const wanted = (kitchens ?? []).filter((k) =>
    asked
      ? k.id === asked ||
        (k.customer_nickname ?? "").toLowerCase().includes(needle)
      : includeInactive || k.is_active,
  );
  if (asked && wanted.length === 0)
    throw new Error(`no kitchen matches "${asked}"`);

  // One sheet per active kitchen, because the customer picks their kitchen and
  // is shown that kitchen's prices. Everything on a sheet is that kitchen's
  // own: its ladder (`tiersForKitchen`), its `delivery_areas` rather than the
  // union, its `offers_size_m`, its `delivery_days`.
  if (wanted.length === 0) throw new Error("no active kitchen to render");
  const sheets: {
    id: string;
    nickname: string | null;
    areas: string[];
    offersM: boolean;
    surcharge: number;
    days: number[];
  }[] = await Promise.all(
    wanted.map(async (k) => ({
      id: k.id,
      nickname: k.customer_nickname,
      areas: (k.delivery_areas as string[] | null) ?? [],
      offersM: !!k.offers_size_m,
      // The sheet prints this kitchen's own M tambahan, the same way it
      // prints this kitchen's own ladder — they differ per kitchen since
      // migration 131.
      surcharge: await sizeMSurcharge(k),
      days: k.delivery_days ?? [1, 2, 3, 4, 5, 6],
    })),
  );

  mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch();

  // "Gratis ongkir" was typed on the sheet while every kitchen was in Tangsel
  // and delivered for nothing. Molls charge Rp 10.000-15.000 on *every* one of
  // their 66 kecamatan, so that line would have promised free delivery across
  // the whole of their coverage — a price claim on the one artefact
  // `send_price_list` hands a customer who asked what things cost.
  //
  // So it is read, like every number here. A kitchen whose neighbourhoods all
  // carry a surcharge states the range; one with a handful of exceptions
  // (Thenie's two Apartemen Akasa rows, migration 086) keeps the old line,
  // which is still true of everywhere else they drive.
  const ongkirFor = async (id: string | null, areas: string[]) => {
    const free = {
      sub: "Gratis ongkir",
      note: "Harga sudah termasuk ongkir",
    };
    if (!id || areas.length === 0) return free;

    // `subcontractor_neighborhoods` is an exclusion list: no row means the
    // kitchen delivers there for nothing. So "carries a fee" cannot be read off
    // the rows alone — Thenie's only two rows are the Apartemen Akasa
    // surcharges of migration 086, and counting those would have announced a
    // standing ongkir on a kitchen that drives Tangsel free. The question is
    // whether the fees cover *every* kecamatan of the areas this kitchen
    // serves, which is what Molls' 66 rows do and Thenie's two do not.
    const [all, priced] = await Promise.all([
      fetchAllRows<{ id: string }>((from, to) =>
        db
          .from("area_neighborhoods")
          .select("id")
          .in("area", areas)
          .range(from, to),
      ),
      fetchAllRows<{ surcharge_per_delivery: number | null }>((from, to) =>
        db
          .from("subcontractor_neighborhoods")
          .select("surcharge_per_delivery")
          .eq("subcontractor_id", id)
          .eq("can_deliver", true)
          .gt("surcharge_per_delivery", 0)
          .range(from, to),
      ),
    ]);
    if (all.error || priced.error)
      throw new Error(all.error ?? priced.error ?? "ongkir lookup failed");

    const fees = priced.rows.map((r) => r.surcharge_per_delivery ?? 0);
    if (all.rows.length === 0 || fees.length < all.rows.length) return free;

    const lo = Math.min(...fees);
    const hi = Math.max(...fees);
    const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
    const range = lo === hi ? rp(lo) : `${rp(lo)}-${rp(hi)}`;
    // No short positive claim fits here, so the segment drops out rather than
    // being padded — the note below carries the real figure.
    return {
      sub: "",
      note: `Harga belum termasuk ongkir ${range} per pengantaran, sesuai area`,
    };
  };

  for (const sheet of sheets) {
    const tierRows = await tiersForKitchen(db, sheet.id);
    if (tierRows.length === 0)
      throw new Error(`no pricing tier for ${sheet.nickname ?? sheet.id}`);
    const tiers: Record<number, number> = {};
    for (const t of tierRows) tiers[t.portions] = t.price_per_portion;

    const m = sheet.offersM ? sheet.surcharge : 0;
    const slug = (sheet.nickname ?? sheet.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const base = `${DIR}/price-list-${slug}`;

    const html = page(
      tiers,
      m,
      sheet.areas,
      sheet.nickname,
      daysLabel(sheet.days),
      await ongkirFor(sheet.id, sheet.areas),
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
      `${base}.png — ${sheet.nickname ?? sheet.id}, ${daysLabel(sheet.days)}, size M ${m ? `on (+${m})` : "off"}`,
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

      const { error } = await db
        .from("subcontractors")
        .update({ price_list_image_url: url })
        .eq("id", sheet.id);
      if (error) throw new Error(error.message);
      console.log(`  → subcontractors.price_list_image_url = ${url}`);
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
