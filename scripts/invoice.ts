/**
 * Renders one invoice PDF from a JSON spec.
 *
 *   npx tsx --env-file=.env.local scripts/invoice.ts spec.json out.pdf
 *
 * Carolin's first invoice was built by a throwaway script on 2026-08-30 and
 * deleted with it, so when she asked for a corrected one the next day the layout
 * had to be rebuilt from a screenshot of the PDF. This file exists so that does
 * not happen a third time. Nothing is uploaded and nothing is sent — see
 * scripts/manual-send.ts for the sending half.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

type Party = { name: string; lines: string[] };
type Item = {
  desc: string;
  sub?: string[];
  qty: string;
  unit: string;
  amount: string;
};

type Spec = {
  number: string;
  date: string;
  due: string;
  paidStamp?: string;
  billTo: Party;
  shipTo: Party;
  items: Item[];
  subtotal: string;
  shipping: string;
  total: string;
  paidLine?: { label: string; amount: string };
  balance: string;
  payment: string[];
  footer: string[];
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;color:#111;font-size:11px;line-height:1.45;padding:52px 56px}
.top{display:flex;justify-content:space-between;align-items:flex-start}
.brand{font-size:22px;font-weight:700;letter-spacing:-.3px}
.brand-sub{color:#666;font-size:9.5px;margin-top:5px}
.title{font-size:26px;font-weight:700;color:#bdbdbd;letter-spacing:4px;text-align:right}
.meta{margin-top:10px;font-size:10px}
.meta div{display:flex;justify-content:flex-end;gap:14px}
.meta .k{color:#777}
.meta .v{min-width:132px;text-align:right}
.stamp{margin-top:12px;display:inline-block;border:1.5px solid #1a7f4b;color:#1a7f4b;font-weight:700;letter-spacing:3px;padding:7px 16px;font-size:11px;float:right}
.rule{border-top:2px solid #111;margin:34px 0 26px}
.parties{display:flex;gap:40px}
.parties>div{flex:1}
.label{font-size:8.5px;letter-spacing:1.6px;color:#777;margin-bottom:7px}
.pname{font-weight:700;font-size:12px;margin-bottom:3px}
.pline{color:#333}
table{width:100%;border-collapse:collapse;margin-top:34px}
th{font-size:8.5px;letter-spacing:1.6px;color:#777;font-weight:600;text-align:right;padding-bottom:8px;border-bottom:1px solid #ddd}
th:first-child{text-align:left}
td{padding:12px 0;vertical-align:top;text-align:right;border-bottom:1px solid #eee}
td:first-child{text-align:left}
.sub{color:#777;font-size:9px;margin-top:3px}
.totals{margin-top:22px;display:flex;justify-content:flex-end}
.totals table{width:52%;margin:0}
.totals td{border:none;padding:5px 0}
.totals tr.line td{border-bottom:1px solid #111}
.totals tr.total td{font-size:14px;font-weight:700;padding-top:10px}
.totals tr.paid td{color:#1a7f4b}
.pay{margin-top:38px;background:#f5f5f4;padding:18px 20px}
.pay .label{margin-bottom:9px}
.foot{margin-top:40px;text-align:center;color:#888;font-size:9px}
`;

function html(s: Spec): string {
  const rows = s.items
    .map(
      (i) =>
        `<tr><td>${i.desc}${(i.sub ?? [])
          .map((x) => `<div class="sub">${x}</div>`)
          .join(
            "",
          )}</td><td>${i.qty}</td><td>${i.unit}</td><td>${i.amount}</td></tr>`,
    )
    .join("");
  const party = (p: Party) =>
    `<div class="pname">${p.name}</div>${p.lines
      .map((l) => `<div class="pline">${l}</div>`)
      .join("")}`;

  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="top">
  <div><div class="brand">Pian Yi Catering</div><div class="brand-sub">Katering harian halal · Tangerang Selatan<br>Instagram @pianyicatering</div></div>
  <div>
    <div class="title">INVOICE</div>
    <div class="meta">
      <div><span class="k">No.</span><span class="v">${s.number}</span></div>
      <div><span class="k">Tanggal</span><span class="v">${s.date}</span></div>
      <div><span class="k">Jatuh tempo</span><span class="v">${s.due}</span></div>
    </div>
    ${s.paidStamp ? `<div class="stamp">${s.paidStamp}</div>` : ""}
  </div>
</div>
<div style="clear:both"></div>
<div class="rule"></div>
<div class="parties">
  <div><div class="label">DITAGIHKAN KEPADA</div>${party(s.billTo)}</div>
  <div><div class="label">DIKIRIM KEPADA</div>${party(s.shipTo)}</div>
</div>
<table>
  <thead><tr><th>DESKRIPSI</th><th>QTY</th><th>HARGA SATUAN</th><th>JUMLAH</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="totals"><table>
  <tr><td>Subtotal</td><td>${s.subtotal}</td></tr>
  <tr class="line"><td>Ongkos kirim</td><td>${s.shipping}</td></tr>
  <tr class="total"><td>Total</td><td>${s.total}</td></tr>
  ${s.paidLine ? `<tr class="paid"><td>${s.paidLine.label}</td><td>${s.paidLine.amount}</td></tr>` : ""}
  <tr><td>Sisa tagihan</td><td>${s.balance}</td></tr>
</table></div>
<div class="pay"><div class="label">PEMBAYARAN DITERIMA</div>${s.payment
    .map((l) => `<div>${l}</div>`)
    .join("")}</div>
<div class="foot">${s.footer.map((l) => `<div>${l}</div>`).join("")}</div>
</body></html>`;
}

async function main() {
  const [specPath, outPath] = process.argv.slice(2);
  if (!specPath || !outPath)
    throw new Error("usage: invoice.ts <spec.json> <out.pdf>");

  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html(spec), { waitUntil: "networkidle" });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();

  writeFileSync(outPath, pdf);
  console.log(`${outPath} — ${spec.number}, ${pdf.length} bytes`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
