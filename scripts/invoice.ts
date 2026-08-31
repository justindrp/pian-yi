/**
 * Renders one invoice PDF from a JSON spec, for the cases the bot does not
 * cover — a correction, a re-issue with hand-written lines, an invoice for
 * something that is not an order.
 *
 *   npx tsx --env-file=.env.local scripts/invoice.ts spec.json out.pdf
 *
 * The layout itself lives in src/lib/invoices/render.ts, which is what the bot's
 * send_invoice tool draws with. It used to live here as HTML printed through
 * headless chromium; two copies of an invoice layout is one copy too many, and
 * the server cannot run chromium anyway. Nothing is uploaded and nothing is
 * sent — see scripts/manual-send.ts for the sending half.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { type InvoiceSpec, renderInvoicePdf } from "@/lib/invoices/render";

async function main() {
  const [specPath, outPath] = process.argv.slice(2);
  if (!specPath || !outPath)
    throw new Error("usage: invoice.ts <spec.json> <out.pdf>");

  const spec = JSON.parse(readFileSync(specPath, "utf8")) as InvoiceSpec;
  const pdf = await renderInvoicePdf(spec);
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
