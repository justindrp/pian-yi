/**
 * Draws one invoice PDF.
 *
 * The layout was first written as HTML and printed through headless chromium,
 * which is fine for a script on a laptop and impossible on Railway: Playwright
 * is a dev dependency and no browser is installed in the container. pdfkit was
 * already a dependency, needs nothing but Node, and the invoice is a header,
 * two addresses, a table and a totals block — the part of the old layout that
 * actually mattered survives the move intact.
 *
 * Everything here is a pre-formatted string. Money, dates and quantities are
 * formatted by the caller (`buildInvoiceSpec`), so this file never has to know
 * what a rupiah is and can be tested by eye against one JSON file.
 *
 * The page follows the Katerloka design system (docs/DESIGN_SYSTEM.md): the
 * outlined lockup from `@/lib/brand/logo`, Plus Jakarta Sans embedded from
 * `src/lib/brand/fonts/`, figures on hairlines and the total in a daun band.
 * The fonts are read off disk, so `next.config.ts` traces that folder into the
 * standalone build the same way it traces pdfkit's own metrics.
 */

import { join } from "node:path";
import PDFDocument from "pdfkit";
import { BRAND, FORMER_NAME, LOCKUP } from "@/lib/brand/logo";

export type InvoiceParty = { name: string; lines: string[] };

export type InvoiceItem = {
  desc: string;
  /** Small grey lines under the description — dates, size, what is in the box. */
  sub?: string[];
  qty: string;
  unit: string;
  amount: string;
};

export type InvoiceSpec = {
  /** A quotation retitles the page and drops the balance line. Default invoice. */
  kind?: "invoice" | "quotation";
  /** Contact lines under the logo, which carries the name. Default Katerloka's own. */
  brand?: { lines: string[] };
  number: string;
  date: string;
  due: string;
  /** "LUNAS" when the money is in. Absent on an unpaid invoice. */
  paidStamp?: string;
  billTo: InvoiceParty;
  shipTo: InvoiceParty;
  items: InvoiceItem[];
  subtotal: string;
  shipping: string;
  total: string;
  paidLine?: { label: string; amount: string };
  balance: string;
  /** The payment block: either how to pay, or how it was paid. */
  payment: string[];
  footer: string[];
};

const M = 48; // page margin
const PAGE_W = 595.28; // A4 portrait, points
const W = PAGE_W - M * 2;
const INK = BRAND.kecap;
const GREY = BRAND.muted;
const RULE = BRAND.line;
const GREEN = BRAND.ok;

const FONT_DIR = join(process.cwd(), "src/lib/brand/fonts");
const REGULAR = "Jakarta";
const SEMIBOLD = "Jakarta-SemiBold";
const BOLD = "Jakarta-Bold";
const EXTRABOLD = "Jakarta-ExtraBold";

/** Right edge of each column, so every number lines up on its last digit. */
const COL = { desc: M, qty: M + 300, unit: M + 400, amount: M + W };

function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number) {
  doc
    .font(EXTRABOLD)
    .fontSize(7)
    .fillColor(GREY)
    .text(text, x, y, { characterSpacing: 0.8 });
}

function right(
  doc: PDFKit.PDFDocument,
  text: string,
  edge: number,
  y: number,
  width = 110,
) {
  doc.text(text, edge - width, y, { width, align: "right" });
}

export function renderInvoicePdf(spec: InvoiceSpec): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: M });
  for (const [name, weight] of [
    [REGULAR, 400],
    [SEMIBOLD, 600],
    [BOLD, 700],
    [EXTRABOLD, 800],
  ] as const)
    doc.registerFont(name, join(FONT_DIR, `PlusJakartaSans-${weight}.ttf`));
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const quote = spec.kind === "quotation";
  const brand = spec.brand ?? {
    lines: [
      "Katering harian halal · Tangerang Selatan",
      "katerloka.com · halo@katerloka.com",
      // The WhatsApp account still carries the old name until Meta approves
      // the new one, so the document says they are the same business.
      FORMER_NAME,
    ],
  };

  // Header — the lockup and brand lines left, the document title right. The
  // lockup is outlined paths, never retyped, so it draws the same everywhere.
  const logoH = 40;
  const scale = logoH / LOCKUP.height;
  doc
    .save()
    .translate(M - 1, M - 10)
    .scale(scale);
  doc.path(LOCKUP.tray).fill(BRAND.cabai, "even-odd");
  doc.circle(LOCKUP.rice.cx, LOCKUP.rice.cy, LOCKUP.rice.r).fill(BRAND.cabai);
  doc.path(LOCKUP.word).fill(BRAND.kecap);
  doc.restore();
  doc.font(REGULAR).fontSize(8).fillColor(GREY);
  for (const [i, line] of brand.lines.entries())
    doc.text(line, M, M + 30 + i * 11);

  doc
    .font(EXTRABOLD)
    .fontSize(22)
    .fillColor(INK)
    .text(quote ? "Penawaran" : "Invoice", M + W - 200, M - 4, {
      width: 200,
      align: "right",
    });

  let metaY = M + 30;
  for (const [k, v] of [
    ["No.", spec.number],
    ["Tanggal", spec.date],
    [quote ? "Berlaku s/d" : "Jatuh tempo", spec.due],
  ] as const) {
    doc.font(REGULAR).fontSize(8.5).fillColor(GREY);
    right(doc, k, COL.amount - 140, metaY);
    doc.fillColor(INK);
    right(doc, v, COL.amount, metaY, 140);
    metaY += 13;
  }

  if (spec.paidStamp) {
    const w = 84;
    const x = COL.amount - w;
    doc
      .lineWidth(1.2)
      .roundedRect(x, metaY + 4, w, 22, 2)
      .stroke(GREEN);
    doc
      .font(EXTRABOLD)
      .fontSize(10)
      .fillColor(GREEN)
      .text(spec.paidStamp, x, metaY + 11, {
        width: w,
        align: "center",
        characterSpacing: 2,
      });
    metaY += 30;
  }

  let y = Math.max(metaY + 18, M + 30 + brand.lines.length * 11 + 14);
  doc
    .lineWidth(2)
    .moveTo(M, y)
    .lineTo(M + W, y)
    .stroke(BRAND.cabai);
  y += 20;

  // Both addresses. They differ whenever a package was bought for someone else:
  // the invoice is billed to whoever paid and shipped to whoever eats.
  const partyTop = y;
  const half = W / 2;
  for (const [i, [head, party]] of (
    [
      [quote ? "DITAWARKAN KEPADA" : "DITAGIHKAN KEPADA", spec.billTo],
      ["DIKIRIM KEPADA", spec.shipTo],
    ] as const
  ).entries()) {
    const x = M + i * half;
    label(doc, head, x, partyTop);
    doc
      .font(BOLD)
      .fontSize(10.5)
      .fillColor(INK)
      .text(party.name, x, partyTop + 13, { width: half - 20 });
    let py = doc.y + 1;
    doc.font(REGULAR).fontSize(8.5).fillColor(BRAND.ink2);
    for (const line of party.lines) {
      doc.text(line, x, py, { width: half - 20 });
      py = doc.y + 1;
    }
    y = Math.max(y, py);
  }
  y += 24;

  // Items.
  label(doc, "DESKRIPSI", COL.desc, y);
  doc.font(EXTRABOLD).fontSize(7).fillColor(GREY);
  right(doc, "QTY", COL.qty, y, 60);
  right(doc, "HARGA SATUAN", COL.unit, y, 90);
  right(doc, "JUMLAH", COL.amount, y, 90);
  y += 12;
  doc
    .lineWidth(0.7)
    .moveTo(M, y)
    .lineTo(M + W, y)
    .stroke(RULE);
  y += 10;

  for (const item of spec.items) {
    const top = y;
    doc
      .font(SEMIBOLD)
      .fontSize(9.5)
      .fillColor(INK)
      .text(item.desc, COL.desc, y, { width: 250 });
    let subY = doc.y + 1;
    doc.font(REGULAR).fontSize(8).fillColor(GREY);
    for (const s of item.sub ?? []) {
      doc.text(s, COL.desc, subY, { width: 250 });
      subY = doc.y + 1;
    }
    doc.font(REGULAR).fontSize(9.5).fillColor(INK);
    right(doc, item.qty, COL.qty, top, 60);
    right(doc, item.unit, COL.unit, top, 90);
    right(doc, item.amount, COL.amount, top, 90);
    y = Math.max(subY, top + 14) + 8;
    doc
      .lineWidth(0.5)
      .moveTo(M, y)
      .lineTo(M + W, y)
      .stroke(RULE);
    y += 10;
  }

  // Totals, right half.
  const tLabel = M + W - 260;
  const totals: [string, string, string?][] = [
    ["Subtotal", spec.subtotal],
    ["Ongkos kirim", spec.shipping],
  ];
  doc.font(REGULAR).fontSize(9.5).fillColor(INK);
  for (const [k, v] of totals) {
    doc.text(k, tLabel, y, { width: 130 });
    right(doc, v, COL.amount, y, 120);
    y += 15;
  }
  // The total sits in a daun band, white on green: the one figure the eye
  // should land on.
  y += 2;
  const bandX = tLabel - 12;
  doc.roundedRect(bandX, y, M + W - bandX, 30, 6).fill(BRAND.daun);
  doc.font(BOLD).fontSize(10).fillColor("#FFFFFF");
  doc.text("Total", tLabel, y + 10, { width: 130 });
  doc.font(EXTRABOLD).fontSize(13);
  right(doc, spec.total, COL.amount - 12, y + 8, 160);
  y += 40;
  if (spec.paidLine) {
    doc.font(REGULAR).fontSize(9.5).fillColor(GREEN);
    doc.text(spec.paidLine.label, tLabel, y, { width: 150 });
    right(doc, spec.paidLine.amount, COL.amount, y, 120);
    y += 15;
  }
  if (!quote) {
    doc.font(SEMIBOLD).fontSize(9.5).fillColor(INK);
    doc.text("Sisa tagihan", tLabel, y, { width: 130 });
    right(doc, spec.balance, COL.amount, y, 120);
  }
  y += quote ? 17 : 32;

  // Payment block.
  const payH = 32 + spec.payment.length * 13;
  doc.roundedRect(M, y, W, payH, 6).fill(BRAND.nasi);
  label(doc, "PEMBAYARAN", M + 14, y + 12);
  doc.font(REGULAR).fontSize(9).fillColor(INK);
  let payY = y + 26;
  for (const line of spec.payment) {
    doc.text(line, M + 14, payY, { width: W - 28 });
    payY = doc.y + 1;
  }
  y += payH + 26;

  doc.font(REGULAR).fontSize(8).fillColor(GREY);
  for (const line of spec.footer) {
    doc.text(line, M, y, { width: W, align: "center" });
    y = doc.y + 2;
  }

  doc.end();
  return done;
}
