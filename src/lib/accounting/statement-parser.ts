// Bank e-statement parsing.
//
// Two formats, because we hold two accounts: a BCA Tahapan PDF and a
// Superbank PDF. Both are text PDFs, so nothing here does OCR — a screenshot
// is stored as an image and its lines are typed in.
//
// Every parse is checked against the statement's own control totals (BCA
// prints MUTASI CR / MUTASI DB with counts, Superbank prints an asset summary
// row). A parser that silently drops a line is worse than one that fails, so
// `controlTotalsOk` is false whenever the sums or counts disagree and the
// caller refuses the import.

import { extractText, getDocumentProxy } from "unpdf";

export type Direction = "CR" | "DB";

/** An account code from the chart of accounts, e.g. "2001". */
export type AccountCode = string;

export interface ParsedLine {
  rowIndex: number;
  txnDate: string; // YYYY-MM-DD
  txnTime: string | null;
  direction: Direction;
  amount: number;
  balanceAfter: number | null;
  counterparty: string | null;
  description: string;
  rawText: string;
  // Which account the other side of this line faces. Null when nothing
  // recognised it, which is where the reconcile queue starts.
  contraAccountCode: AccountCode | null;
}

export interface ParsedStatement {
  bank: "BCA" | "Superbank";
  accountNumber: string;
  accountLabel: string | null;
  currency: string;
  /** The ledger account this statement is evidence for: 1002, 1003, 1006. */
  bankAccountCode: AccountCode;
  periodStart: string;
  periodEnd: string;
  openingBalance: number | null;
  closingBalance: number | null;
  totalCredit: number;
  totalDebit: number;
  creditCount: number;
  debitCount: number;
  lines: ParsedLine[];
  // The statement's own printed totals, when it prints them.
  statedCredit: number | null;
  statedDebit: number | null;
  statedCreditCount: number | null;
  statedDebitCount: number | null;
  controlTotalsOk: boolean;
  warnings: string[];
}

export async function extractPdfPages(data: Uint8Array): Promise<string[]> {
  // BCA encrypts its e-statements with an empty user password, which pdf.js
  // opens without being asked for one.
  const doc = await getDocumentProxy(data, { password: "" });
  const { text } = await extractText(doc, { mergePages: false });
  return Array.isArray(text) ? text : [text];
}

export function detectFormat(text: string): "BCA" | "Superbank" | null {
  if (/NO\.\s*REKENING\s*:/i.test(text) && /MUTASI\s+CR/i.test(text)) {
    return "BCA";
  }
  if (/Super\s*[Bb]ank/.test(text) && /Tabungan Utama/.test(text)) {
    return "Superbank";
  }
  return null;
}

// ------------------------------------------------------------ classification

// A bank line has two sides and one of them is already known: the statement's
// own account. So classifying a line means naming its contra account, and the
// names come from the chart of accounts rather than a parallel list of
// buckets — a bucket that maps to no account is a line that can never be
// journalised.
//
// The statements name individuals, not roles. Andreas Kurnianto is Thenie's
// owner — Dapur 1 — and every daily kitchen settlement is in his name; the
// masked "Dnid Sal…Put…" is the courier's kasbon. Without these, Rp 17jt of
// kitchen cost reads as unexplained personal transfers.
const RULES: { re: RegExp; account: AccountCode }[] = [
  // Settling what the kitchen is already owed: 5001/2001 accrued it, this
  // pays it down.
  { re: /ANDREAS KURNI|LILI ANGGRAINI/i, account: "2001" },
  { re: /Dnid Sal\w*\s+Put|Dnid Donx Kur/i, account: "1201" },
  // Delivery bought from outside. The two masked Superbank payees are
  // Lalamove drivers hired on 27 and 28 Juli 2026, one ride each — the two
  // drops our own courier did not make. He is paid by the drop, not the day
  // (Rp 3.000.000 a month over 22 days at 2 deliveries a day), so those two
  // rides cost his wage 2 x Rp 68.181,82, not two days' pay. Daevin Thomas is
  // a courier who worked a five-day trial. Superbank masks external payees,
  // so all three read as strangers.
  {
    re: /LALAMOVE|GOJEK|GRAB ?BIKE|Dnid Sxx Asrx|Dnid Als\w*\s+Ros|DAEVIN THOMAS/i,
    account: "5002",
  },
  // Molls Kitchen — Ika Purnama Sari is its owner. Cooked Ade Dian's ICE BSD
  // event on 20 Agustus 2026.
  { re: /IKA PURNAMA SARI/i, account: "2001" },
  { re: /FACEBK|FACEBOOK|\bMETA PLATFORMS\b/i, account: "6001" },
  // GOOGLE*CHROME is a card authorisation hold from trying to pay an AI
  // provider; the debit and credit reverse the same day and net to nothing.
  {
    re: /DEEPSEEK|ANTHROPIC|OPENAI|RAILWAY|SUPABASE|VERCEL|GOOGLE\*CHROME/i,
    account: "6003",
  },
  { re: /BIAYA ADM|PAJAK BUNGA/i, account: "6002" },
  { re: /^BUNGA\b|Bunga Didapat/i, account: "4900" },
  { re: /SHOPEEPAY/i, account: "1005" },
  { re: /POKET VALAS|FTMCA/i, account: "1006" },
  { re: /AGNESIA/i, account: "1003" },
  // Loan proceeds. Justin borrows in his own name and puts the money in, so
  // what the business owes is owed to him — 2002, not a loan account.
  { re: /KREDIT UTAMA|INFO TEKNO|Transfer Other Ban/i, account: "2002" },
  {
    re: /FLAZZ|\/DANA\b|TARIKAN ATM|SPBU|SETORAN VIA CDM|ESPAY|RAHMA MAULIDA|PINTR\.ID|BICARAKAN\.ID|DANIEL RAHARDYAN P|Daniel Rahardyan Pramady/i,
    account: "2002",
  },
];

export function classify(
  text: string,
  direction: Direction,
  bankAccountCode: AccountCode,
): AccountCode | null {
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    // The same counterparty means different things on different statements.
    // Justin's name on his own BCA line is a drawing or an injection (2002);
    // on Agnes's Superbank it is the float arriving from BCA (1002), and
    // booking that to 2002 would double-count him as a creditor.
    if (r.account === "2002" && bankAccountCode !== "1002") return "1002";
    // A line never faces its own account.
    if (r.account === bankAccountCode) return "1002";
    return r.account;
  }
  // An unrecognised credit is almost always a customer paying ahead of
  // delivery, which is where order_payment already books it. An unrecognised
  // debit could be anything, so it is left for a human rather than guessed
  // into an account nobody will re-check.
  return direction === "CR" ? "2100" : null;
}

/**
 * Which ledger account a statement is the evidence for. Keyed on bank and
 * currency rather than on an account number, so a second BCA account does not
 * need a code change — the upload route can override it.
 */
export function resolveBankAccount(
  bank: "BCA" | "Superbank",
  currency: string,
): AccountCode {
  if (bank === "Superbank") return "1003";
  return currency === "IDR" ? "1002" : "1006";
}

// ---------------------------------------------------------------------- BCA

const MONTHS_ID: Record<string, number> = {
  JANUARI: 1,
  FEBRUARI: 2,
  MARET: 3,
  APRIL: 4,
  MEI: 5,
  JUNI: 6,
  JULI: 7,
  AGUSTUS: 8,
  SEPTEMBER: 9,
  OKTOBER: 10,
  NOVEMBER: 11,
  DESEMBER: 12,
};

const MONTHS_SHORT: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  Mei: 5,
  May: 5,
  Jun: 6,
  Jul: 7,
  Agu: 8,
  Aug: 8,
  Sep: 9,
  Okt: 10,
  Oct: 10,
  Nov: 11,
  Des: 12,
  Dec: 12,
};

// Boilerplate repeated on every page of a BCA statement.
const BCA_NOISE = [
  /^REKENING /,
  /^KCU /,
  /^NO\. REKENING/,
  /^HALAMAN/,
  /^PERIODE/,
  /^MATA UANG/,
  /^FASILITAS/,
  /^KETERANGAN : -/,
  /^CATATAN:/,
  /^Apabila nasabah/,
  /^Rekening ini/,
  /^telah menyetujui/,
  /^menyetujui segala/,
  /^BCA berhak/,
  /^Laporan Mutasi/,
  /^Mutasi bulanan/,
  /^bulan bersangkutan/,
  /^ *•/,
  /^Bersambung/,
  /^TANGGAL KETERANGAN/,
  /^\d+ ?\/$/,
  /^\d+$/,
];

// A statement line begins with DD/MM followed by one of the transaction
// keywords BCA actually prints. The keyword test matters: a continuation line
// can itself start with a date ("30/07  WSID:ZR261" inside a CDM deposit),
// and treating that as a new record splits one transaction into two, dating
// the money a day early.
const BCA_KEYWORDS =
  /^\d{2}\/\d{2}\s+(TRSF|BI-FAST|SWITCHING|BIAYA|FLAZZ|DB |KR |TARIKAN|SETORAN|BUNGA|SALDO|TRANSAKSI|PAJAK|KOREKSI|ADM|CR )/;

const AMT = String.raw`\d{1,3}(?:,\d{3})*\.\d{2}`;
// The mutasi sits on a line of its own: the amount, an optional DB marker,
// and an optional running balance. Nothing else.
const AMT_WHOLE = new RegExp(`^(${AMT})(\\s+DB)?(\\s+${AMT})?$`);
// Single-line records (BIAYA ADM, BUNGA) put it at the end of the description
// instead. The lookbehind keeps "USD2.00" and "00000.00SPBU" from matching.
const AMT_TAIL = new RegExp(`(?<![A-Za-z0-9,.])(${AMT})(\\s+DB)?(\\s+${AMT})?$`);

function num(s: string): number {
  return Number.parseFloat(s.replace(/,/g, ""));
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A BCA PDF holds one statement per currency — the IDR account and, when it
 * has moved, the USD Poket Valas. They close on separate control totals, so
 * they are returned as separate statements.
 */
export function parseBcaStatement(pages: string[]): ParsedStatement[] {
  const full = pages.join("\n");
  const accountNumber =
    full.match(/NO\. REKENING\s*:\s*(\d+)/)?.[1] ?? "unknown";
  const periodRaw = full.match(/PERIODE\s*:\s*([A-Z]+)\s+(\d{4})/i);
  const month = MONTHS_ID[(periodRaw?.[1] ?? "").toUpperCase()] ?? 0;
  const year = Number(periodRaw?.[2] ?? 0);
  const accountLabel =
    full.split("\n").find((l) => /^[A-Z][A-Z ]{6,}$/.test(l.trim()))?.trim() ??
    null;

  if (!month || !year) {
    throw new Error("BCA statement: could not read PERIODE");
  }

  // Split the pages into currency sections. Every page states its own
  // MATA UANG, so a page belongs to whichever currency it declares.
  const sections = new Map<string, string[]>();
  for (const page of pages) {
    const cur = page.match(/MATA UANG\s*:\s*(\w+)/)?.[1] ?? "IDR";
    const bucket = sections.get(cur) ?? [];
    bucket.push(page);
    sections.set(cur, bucket);
  }

  const out: ParsedStatement[] = [];
  for (const [currency, sectionPages] of sections) {
    out.push(
      parseBcaSection(sectionPages.join("\n"), {
        accountNumber,
        accountLabel,
        currency,
        month,
        year,
      }),
    );
  }
  return out;
}

function parseBcaSection(
  text: string,
  meta: {
    accountNumber: string;
    accountLabel: string | null;
    currency: string;
    month: number;
    year: number;
  },
): ParsedStatement {
  const warnings: string[] = [];
  const { month, year } = meta;
  const bankAccountCode = resolveBankAccount("BCA", meta.currency);

  const summary = text.slice(text.indexOf("SALDO AWAL :"));
  const stated = {
    opening: summary.match(/SALDO AWAL\s*:\s*([\d,]+\.\d{2})/)?.[1],
    closing: summary.match(/SALDO AKHIR\s*:\s*([\d,]+\.\d{2})/)?.[1],
    cr: summary.match(/MUTASI CR\s*:\s*([\d,]+\.\d{2})\s*(\d+)?/),
    db: summary.match(/MUTASI DB\s*:\s*([\d,]+\.\d{2})\s*(\d+)?/),
  };

  const body = text.split("SALDO AWAL :")[0];
  const kept = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !BCA_NOISE.some((re) => re.test(l.trim())));

  // Group into records.
  const records: string[][] = [];
  for (const line of kept) {
    if (BCA_KEYWORDS.test(line.trim())) records.push([line.trim()]);
    else if (records.length) records[records.length - 1].push(line.trim());
  }

  const lines: ParsedLine[] = [];
  for (const rec of records) {
    if (/^\d{2}\/\d{2}\s+SALDO AWAL/.test(rec[0])) continue;

    const dd = Number(rec[0].slice(0, 2));
    const mm = Number(rec[0].slice(3, 5));
    // A statement's first days can carry transactions BCA booked in the
    // previous month; the record's own month is the one that counts.
    const y = mm === 12 && month === 1 ? year - 1 : year;

    // The description keeps the date off the front but nothing else — the
    // instruction amount, the reference and the counterparty are all in it.
    const body0 = rec[0].slice(6).trim();
    const parts = [body0, ...rec.slice(1)];

    let hit: RegExpMatchArray | null = null;
    for (const p of parts) {
      const m = p.match(AMT_WHOLE);
      if (m) {
        hit = m;
        break;
      }
    }
    if (!hit) {
      for (const p of parts) {
        const m = p.match(AMT_TAIL);
        if (m) {
          hit = m;
          break;
        }
      }
    }
    if (!hit) {
      warnings.push(`no amount found: ${parts.join(" ").slice(0, 80)}`);
      continue;
    }

    const raw = parts.join(" ").replace(/\s+/g, " ").trim();
    const direction: Direction = hit[2] ? "DB" : "CR";
    // The counterparty is the last all-caps or name-cased fragment before the
    // amount; BCA truncates it to 18 characters.
    const counterparty =
      parts
        .filter((p) => !AMT_WHOLE.test(p) && /[A-Za-z]{3}/.test(p) && p !== "-")
        .pop()
        ?.slice(0, 60) ?? null;

    lines.push({
      rowIndex: lines.length,
      txnDate: isoDate(y, mm, dd),
      txnTime: null,
      direction,
      amount: num(hit[1]),
      balanceAfter: hit[3] ? num(hit[3].trim()) : null,
      counterparty,
      description: raw.slice(0, 500),
      rawText: raw,
      contraAccountCode: classify(raw, direction, bankAccountCode),
    });
  }

  const totalCredit = round2(sum(lines.filter((l) => l.direction === "CR")));
  const totalDebit = round2(sum(lines.filter((l) => l.direction === "DB")));
  const creditCount = lines.filter((l) => l.direction === "CR").length;
  const debitCount = lines.filter((l) => l.direction === "DB").length;

  const statedCredit = stated.cr ? num(stated.cr[1]) : null;
  const statedDebit = stated.db ? num(stated.db[1]) : null;
  const statedCreditCount = stated.cr?.[2] ? Number(stated.cr[2]) : null;
  const statedDebitCount = stated.db?.[2] ? Number(stated.db[2]) : null;

  const ok =
    statedCredit !== null &&
    statedDebit !== null &&
    Math.abs(statedCredit - totalCredit) < 0.01 &&
    Math.abs(statedDebit - totalDebit) < 0.01 &&
    (statedCreditCount === null || statedCreditCount === creditCount) &&
    (statedDebitCount === null || statedDebitCount === debitCount);

  if (!ok) {
    warnings.push(
      `control totals disagree: parsed CR ${totalCredit} × ${creditCount} / DB ${totalDebit} × ${debitCount}, statement says CR ${statedCredit} × ${statedCreditCount} / DB ${statedDebit} × ${statedDebitCount}`,
    );
  }

  return {
    bank: "BCA",
    accountNumber: meta.accountNumber,
    accountLabel: meta.accountLabel,
    currency: meta.currency,
    bankAccountCode,
    periodStart: isoDate(year, month, 1),
    periodEnd: isoDate(year, month, lastDayOfMonth(year, month)),
    openingBalance: stated.opening ? num(stated.opening) : null,
    closingBalance: stated.closing ? num(stated.closing) : null,
    totalCredit,
    totalDebit,
    creditCount,
    debitCount,
    statedCredit,
    statedDebit,
    statedCreditCount,
    statedDebitCount,
    controlTotalsOk: ok,
    lines,
    warnings,
  };
}

// ---------------------------------------------------------------- Superbank

// Date, clock, description, signed amount, running balance. The extractor
// breaks the line after the description on some rows and not on others — the
// same statement does both — so the separator before the amount is any
// whitespace. Requiring a newline dropped 18 of 49 rows and the control
// totals still had to be read to notice.
const SB_ROW =
  /(\d{1,2} \w{3})\n(\d{2}:\d{2} [AP]M)\n(.+?)\s([+-])Rp([\d.]+,\d{2}) Rp([\d.]+,\d{2})/g;

function idrNum(s: string): number {
  return Number.parseFloat(s.replace(/\./g, "").replace(",", "."));
}

export function parseSuperbankStatement(pages: string[]): ParsedStatement {
  const text = pages.join("\n");
  const warnings: string[] = [];

  const accountNumber =
    text.match(/Tabungan Utama\s*-\s*(\d+)/)?.[1] ?? "unknown";
  const accountLabel =
    text.match(/\n([A-Z][A-Z ]{6,})\n[A-Z]/)?.[1]?.trim() ?? null;

  const period = text.match(
    /(\d{1,2})\s*-\s*(\d{1,2})\s+(\w{3})\s+(\d{4})/,
  );
  if (!period) throw new Error("Superbank statement: could not read Periode");
  const month = MONTHS_SHORT[period[3]];
  const year = Number(period[4]);
  if (!month) throw new Error(`Superbank statement: unknown month ${period[3]}`);

  // "Tabungan Utama Rp0,00 -Rp9.664.630,00 +Rp10.337.639,37 Rp673.009,37"
  const sumRow = text.match(
    /Tabungan Utama Rp([\d.]+,\d{2}) -Rp([\d.]+,\d{2}) \+Rp([\d.]+,\d{2}) Rp([\d.]+,\d{2})/,
  );

  const bankAccountCode = resolveBankAccount("Superbank", "IDR");
  const lines: ParsedLine[] = [];
  for (const m of text.matchAll(SB_ROW)) {
    const day = Number(m[1].split(" ")[0]);
    const mon = MONTHS_SHORT[m[1].split(" ")[1]] ?? month;
    const direction: Direction = m[4] === "+" ? "CR" : "DB";
    const desc = m[3].trim();
    const raw = `${m[1]} ${m[2]} ${desc}`;
    lines.push({
      rowIndex: lines.length,
      txnDate: isoDate(year, mon, day),
      txnTime: m[2],
      direction,
      amount: idrNum(m[5]),
      balanceAfter: idrNum(m[6]),
      counterparty: desc.replace(/^Transfer (ke|dari)\s+/, "") || null,
      description: desc.slice(0, 500),
      rawText: raw,
      contraAccountCode: classify(desc, direction, bankAccountCode),
    });
  }

  const totalCredit = round2(sum(lines.filter((l) => l.direction === "CR")));
  const totalDebit = round2(sum(lines.filter((l) => l.direction === "DB")));

  const statedDebit = sumRow ? idrNum(sumRow[2]) : null;
  const statedCredit = sumRow ? idrNum(sumRow[3]) : null;
  const ok =
    statedCredit !== null &&
    statedDebit !== null &&
    Math.abs(statedCredit - totalCredit) < 0.01 &&
    Math.abs(statedDebit - totalDebit) < 0.01;

  if (!ok) {
    warnings.push(
      `control totals disagree: parsed CR ${totalCredit} / DB ${totalDebit}, statement says CR ${statedCredit} / DB ${statedDebit}`,
    );
  }

  return {
    bank: "Superbank",
    accountNumber,
    accountLabel,
    currency: "IDR",
    bankAccountCode,
    periodStart: isoDate(year, month, Number(period[1])),
    periodEnd: isoDate(year, month, Number(period[2])),
    openingBalance: sumRow ? idrNum(sumRow[1]) : null,
    closingBalance: sumRow ? idrNum(sumRow[4]) : null,
    totalCredit,
    totalDebit,
    creditCount: lines.filter((l) => l.direction === "CR").length,
    debitCount: lines.filter((l) => l.direction === "DB").length,
    statedCredit,
    statedDebit,
    statedCreditCount: null,
    statedDebitCount: null,
    controlTotalsOk: ok,
    lines,
    warnings,
  };
}

export async function parseStatementPdf(
  data: Uint8Array,
): Promise<ParsedStatement[]> {
  const pages = await extractPdfPages(data);
  const format = detectFormat(pages.join("\n"));
  if (format === "BCA") return parseBcaStatement(pages);
  if (format === "Superbank") return [parseSuperbankStatement(pages)];
  throw new Error("Unrecognised statement format (expected BCA or Superbank)");
}

function sum(lines: ParsedLine[]): number {
  return lines.reduce((s, l) => s + l.amount, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
