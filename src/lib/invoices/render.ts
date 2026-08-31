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
 */

import PDFDocument from "pdfkit";

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
const INK = "#111111";
const GREY = "#777777";
const RULE = "#dddddd";
const GREEN = "#1a7f4b";

/** Right edge of each column, so every number lines up on its last digit. */
const COL = { desc: M, qty: M + 300, unit: M + 400, amount: M + W };

function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number) {
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(GREY)
    .text(text, x, y, { characterSpacing: 1.2 });
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
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Header — brand left, invoice meta right.
  doc
    .font("Helvetica-Bold")
    .fontSize(19)
    .fillColor(INK)
    .text("Pian Yi Catering", M, M);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(GREY)
    .text("Katering harian halal · Tangerang Selatan", M, M + 24)
    .text("Instagram @pianyicatering", M, M + 35);

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#bdbdbd")
    .text("INVOICE", M + W - 200, M - 2, {
      width: 200,
      align: "right",
      characterSpacing: 3,
    });

  let metaY = M + 30;
  for (const [k, v] of [
    ["No.", spec.number],
    ["Tanggal", spec.date],
    ["Jatuh tempo", spec.due],
  ] as const) {
    doc.font("Helvetica").fontSize(8.5).fillColor(GREY);
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
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(GREEN)
      .text(spec.paidStamp, x, metaY + 11, {
        width: w,
        align: "center",
        characterSpacing: 2,
      });
    metaY += 30;
  }

  let y = Math.max(metaY + 18, M + 74);
  doc
    .lineWidth(1.5)
    .moveTo(M, y)
    .lineTo(M + W, y)
    .stroke(INK);
  y += 20;

  // Both addresses. They differ whenever a package was bought for someone else:
  // the invoice is billed to whoever paid and shipped to whoever eats.
  const partyTop = y;
  const half = W / 2;
  for (const [i, [head, party]] of (
    [
      ["DITAGIHKAN KEPADA", spec.billTo],
      ["DIKIRIM KEPADA", spec.shipTo],
    ] as const
  ).entries()) {
    const x = M + i * half;
    label(doc, head, x, partyTop);
    doc
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .fillColor(INK)
      .text(party.name, x, partyTop + 13, { width: half - 20 });
    let py = doc.y + 1;
    doc.font("Helvetica").fontSize(8.5).fillColor("#333333");
    for (const line of party.lines) {
      doc.text(line, x, py, { width: half - 20 });
      py = doc.y + 1;
    }
    y = Math.max(y, py);
  }
  y += 24;

  // Items.
  label(doc, "DESKRIPSI", COL.desc, y);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(GREY);
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
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(INK)
      .text(item.desc, COL.desc, y, { width: 250 });
    let subY = doc.y + 1;
    doc.fontSize(8).fillColor(GREY);
    for (const s of item.sub ?? []) {
      doc.text(s, COL.desc, subY, { width: 250 });
      subY = doc.y + 1;
    }
    doc.font("Helvetica").fontSize(9.5).fillColor(INK);
    right(doc, item.qty, COL.qty, top, 60);
    right(doc, item.unit, COL.unit, top, 90);
    right(doc, item.amount, COL.amount, top, 90);
    y = Math.max(subY, top + 14) + 8;
    doc
      .lineWidth(0.5)
      .moveTo(M, y)
      .lineTo(M + W, y)
      .stroke("#eeeeee");
    y += 10;
  }

  // Totals, right half.
  const tLabel = M + W - 260;
  const totals: [string, string, string?][] = [
    ["Subtotal", spec.subtotal],
    ["Ongkos kirim", spec.shipping],
  ];
  doc.font("Helvetica").fontSize(9.5).fillColor(INK);
  for (const [k, v] of totals) {
    doc.text(k, tLabel, y, { width: 130 });
    right(doc, v, COL.amount, y, 120);
    y += 15;
  }
  doc
    .lineWidth(0.8)
    .moveTo(tLabel, y)
    .lineTo(M + W, y)
    .stroke(INK);
  y += 8;
  doc.font("Helvetica-Bold").fontSize(12.5);
  doc.text("Total", tLabel, y, { width: 130 });
  right(doc, spec.total, COL.amount, y, 120);
  y += 20;
  if (spec.paidLine) {
    doc.font("Helvetica").fontSize(9.5).fillColor(GREEN);
    doc.text(spec.paidLine.label, tLabel, y, { width: 150 });
    right(doc, spec.paidLine.amount, COL.amount, y, 120);
    y += 15;
  }
  doc.font("Helvetica").fontSize(9.5).fillColor(INK);
  doc.text("Sisa tagihan", tLabel, y, { width: 130 });
  right(doc, spec.balance, COL.amount, y, 120);
  y += 32;

  // Payment block.
  const payH = 26 + spec.payment.length * 12;
  doc.rect(M, y, W, payH).fill("#f5f5f4");
  label(doc, "PEMBAYARAN", M + 14, y + 12);
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  let payY = y + 26;
  for (const line of spec.payment) {
    doc.text(line, M + 14, payY, { width: W - 28 });
    payY = doc.y + 1;
  }
  y += payH + 26;

  doc.font("Helvetica").fontSize(8).fillColor("#888888");
  for (const line of spec.footer) {
    doc.text(line, M, y, { width: W, align: "center" });
    y = doc.y + 2;
  }

  doc.end();
  return done;
}
