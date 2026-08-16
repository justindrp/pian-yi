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

export function sanitizeReply(text: string): string {
  const paragraphs = stripReasoning(
    unquote(text)
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

  return kept.join("\n\n").trim();
}
