import { looksEnglish } from "@/lib/claude/language";

// Last pass over an outbound reply, after validation and the language guard.
//
// The model occasionally dresses its answer up as a quotation and then restates
// it: a 2026-08-16 simulator run came back as `"Belum ada kak. Menu minggu
// ini ..."` followed by a blank line and a second paragraph saying the same
// thing in different words. The quoting is deterministic to strip; the restating
// is not, so only paragraphs that really are the same text get dropped.

/** Whole reply wrapped in one pair of quotes — the customer should not see them. */
function unquote(text: string): string {
  const t = text.trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["“", "”"],
    ["'", "'"],
  ];
  for (const [open, close] of pairs) {
    if (t.length > 2 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, -close.length);
      // Only if the quotes actually wrap the whole thing. `"a" and "b"` has a
      // quote at each end but is two quoted fragments, not one.
      if (!inner.includes(close)) return inner.trim();
    }
  }
  return t;
}

function normalize(paragraph: string): string {
  return paragraph
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drops a leaked reasoning preamble.
 *
 * `NO_THINKING` stops DeepSeek emitting a `thinking` block, but not always its
 * deliberation: a 2026-08-16 run answered "Hmm, "minggu depannya lagi" — this is
 * ambiguous. ... Let me respond in Indonesian, using "kak," no more than 200
 * words.Betul kak, untuk minggu Senin 24 – Sabtu 29 Agustus 2026 belum ...",
 * all in one text block. The webhook takes the last text block, so this ships to
 * the customer as-is.
 *
 * Two shapes: whole leading paragraphs, and a final preamble sentence glued to
 * the answer with no space after its full stop — punctuation no human types.
 */

// `looksEnglish` alone cannot classify these paragraphs: it returns false on any
// Indonesian marker, and deliberation about an Indonesian reply quotes the
// customer's own words ("minggu depannya lagi", "kak"), so the leak reads as
// Indonesian to it. The tell is the model talking to itself, so match that
// directly as well.
const REASONING_OPENERS =
  /^(hmm|wait|let me|i (should|need|will|must|can|'ll)\b|the customer\b|so the customer\b)/i;

function isReasoning(paragraph: string): boolean {
  return REASONING_OPENERS.test(paragraph.trim()) || looksEnglish(paragraph);
}

/** Splits off a preamble sentence run together with the answer that follows it. */
function unglue(paragraph: string): string {
  // `[\s\S]` rather than `.` with the `s` flag — the tsconfig target predates it.
  const glued = paragraph.match(/^([\s\S]*?[.!?])(?=[A-Z][a-z])/);
  if (!glued || !isReasoning(glued[1])) return paragraph;
  return paragraph.slice(glued[1].length).trim();
}

function stripReasoning(paragraphs: string[]): string[] {
  const unglued = paragraphs.map(unglue);
  const firstAnswer = unglued.findIndex((p) => !isReasoning(p));
  // Nothing left that reads as an answer: a plain English reply, which the
  // language guard translates. Not ours to cut.
  if (firstAnswer === -1) return paragraphs;
  return unglued.slice(firstAnswer);
}

/**
 * Drops a false start the model then retracts.
 *
 * The Indonesian sibling of the reasoning leak, and invisible to `isReasoning`
 * because every word of it is Indonesian. Asked for 13 porsi on 2026-08-16 the
 * bot shipped: "Kami punya paket 12 porsi (Rp 336.000) atau 14... Sebentar,
 * izinkan saya cek lagi. Paket yang tersedia: 12 porsi atau 15 porsi kak." The
 * customer sees the wrong answer, the truncation, and the model checking itself.
 *
 * Only unambiguous self-corrections count. "Sebentar ya kak, saya cek dulu" is a
 * real thing to say to a customer while asking an admin, and must survive — as
 * must any retraction with nothing after it, which is that same promise.
 */
const RETRACTIONS =
  /(sebentar,?\s+izinkan saya cek lagi|izinkan saya cek lagi|maaf,?\s+saya koreksi|saya koreksi|koreksi:|maaf salah|ralat:)/gi;

function stripRetraction(text: string): string {
  RETRACTIONS.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let m = RETRACTIONS.exec(text); m !== null; m = RETRACTIONS.exec(text)) {
    last = m;
  }
  // Nothing retracted if the reply opens with it — that is a plain "give me a
  // moment", not a correction of something already said.
  if (!last || last.index === 0) return text;

  const after = text.slice(last.index + last[0].length);
  const end = after.search(/[.!?]/);
  if (end === -1) return text;
  const answer = after.slice(end + 1).trim();
  return answer.length > 0 ? answer : text;
}

/**
 * Drops a bracketed stage direction standing in for an image.
 *
 * `historyContent()` rewrites every image we have sent to
 * "[gambar terkirim ke customer]" so the model never sees a bare storage URL to
 * copy. It copied the replacement instead: on 2026-08-26 ****7277 was sent
 * "Berikut menu gambar untuk minggu ini ... saya kirimkan ya.\n\n[gambar menu
 * terkirim]" with no `send_menu_image` call behind it, then the same brackets
 * again four minutes later. The customer read our stage direction verbatim and
 * answered "belum ada fotonya kak maaf".
 *
 * The missing image is handled by the webhook, which resends it. This is the
 * other half: the brackets are ours and must never be on a customer's screen,
 * whether or not an image ends up going out. A paragraph that is nothing else
 * disappears; inline, only the brackets are cut.
 */
export const IMAGE_STAGE_DIRECTION =
  /\[[^\]\n]{0,60}?\b(gambar|foto|menu|image)\b[^\]\n]{0,60}?\b(terkirim|dikirim|dilampirkan|terlampir|sent|attached)\b[^\]\n]{0,20}\]|\[\s*(gambar|foto|image)\s+(menu|harga|price list)[^\]\n]{0,40}\]/gi;

function stripStageDirections(text: string): string {
  return text
    .replace(IMAGE_STAGE_DIRECTION, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drops a bracketed aside the model addressed to us instead of the customer.
 *
 * On 2026-09-01 Clairine asked whether her food had arrived and the reply
 * opened with a sentence to her, then shipped this on its own line:
 * "[Warning: bagian ini aku tulis ulang tanpa klaim data pelanggan, karena
 * memang belum aku lihat catatannya — kalau mau aku diverifikasi dulu, aku
 * tanya langsung ya]". It is the model narrating its compliance with the
 * validator's corrective instruction, in Indonesian, so neither `looksEnglish`
 * nor `REASONING_OPENERS` sees it and it is not a stage direction about an
 * image.
 *
 * Keyed on the label rather than on the brackets, because the webhook writes
 * bracketed labels of its own into the history — `[Bukti pembayaran dikirim]`
 * — and those are real descriptions of what happened. Only a bracket that
 * opens by naming itself as commentary is ours.
 */
const META_BRACKET =
  /\[\s*(warning|caution|peringatan|note|disclaimer|internal|sistem|system)\b[^\]]{0,400}\]/gi;

function stripMetaBrackets(text: string): string {
  return text
    .replace(META_BRACKET, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * WhatsApp bold is `*one asterisk*`. Markdown `**two**` renders literally, and
 * the model mixes the two within a single conversation — the 2026-08-16 pricing
 * run sent `*Rp 420.000*` and `**Rp 1.300.000**` two replies apart.
 */
function normalizeBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "*$1*");
}

export function sanitizeReply(text: string): string {
  const paragraphs = stripReasoning(
    stripMetaBrackets(stripStageDirections(stripRetraction(unquote(text))))
      .split(/\n{2,}/)
      .map((p) => unquote(p))
      .filter((p) => p.length > 0),
  );

  const kept: string[] = [];
  const seen: string[] = [];
  for (const p of paragraphs) {
    const key = normalize(p);
    // A repeat, or a paragraph wholly contained in one already sent. Short
    // lines are exempt: "Terima kasih ya kak" legitimately follows an order
    // summary that also thanks the customer.
    const duplicate =
      key.length > 40 && seen.some((s) => s === key || s.includes(key));
    if (duplicate) continue;
    kept.push(p);
    seen.push(key);
  }

  return normalizeBold(kept.join("\n\n").trim());
}
