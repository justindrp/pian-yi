// Customer-facing replies must be Indonesian, and nothing enforced that.
//
// validateReply() only checks whether a reply invents customer data, so a reply
// in the wrong language passed straight through to WhatsApp. The model slips
// into English mainly on the short sentence that accompanies a tool call —
// "I'll send the menu image for you to check." went out that way in a simulator
// run on 2026-08-15, alongside a correctly-Indonesian reply to the very next
// question.
//
// The check is deliberately conservative: replies routinely carry English
// fragments (a customer's name, "next week", "cancel"), and rewriting a good
// Indonesian reply is worse than letting one English word through. So a reply
// is only treated as English when it has NO Indonesian marker at all and at
// least two English ones.

import {
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";

// Function words with no Indonesian homograph. "menu", "ok" and the like are
// deliberately absent from both lists — they are shared and prove nothing.
const INDONESIAN = new Set([
  "kak",
  "ya",
  "yang",
  "saya",
  "kami",
  "kita",
  "untuk",
  "dan",
  "di",
  "ke",
  "dari",
  "tidak",
  "nggak",
  "gak",
  "sudah",
  "udah",
  "belum",
  "bisa",
  "akan",
  "dengan",
  "ini",
  "itu",
  "aja",
  "saja",
  "nya",
  "mohon",
  "maaf",
  "terima",
  "kasih",
  "silakan",
  "pesan",
  "pesanan",
  "porsi",
  "hari",
  "minggu",
  "kirim",
  "kirimkan",
  "ada",
  "mau",
  "juga",
  "atau",
  "kalau",
  "biar",
  "baik",
  "nanti",
  "dulu",
  "jam",
  "harga",
  "besok",
  "dapur",
  "makan",
  "siang",
  "malam",
]);

const ENGLISH = new Set([
  "the",
  "i",
  "you",
  "your",
  "we",
  "our",
  "will",
  "for",
  "to",
  "of",
  "is",
  "are",
  "and",
  "please",
  "send",
  "check",
  "sorry",
  "can",
  "let",
  "me",
  "it",
  "this",
  "that",
  "have",
  "has",
  "with",
  "be",
  "do",
  "does",
  "thanks",
  "here",
  "want",
  "would",
  "should",
  "there",
  "was",
  "were",
  "on",
  "at",
  "as",
  "so",
]);

/** Tokens, lowercased, apostrophes kept so "i'll" reduces to "i". */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).map((w) =>
    w.replace(/'.*$/, ""),
  );
}

export function looksEnglish(text: string): boolean {
  const tokens = words(text);
  if (tokens.length === 0) return false;

  let english = 0;
  for (const w of tokens) {
    if (INDONESIAN.has(w)) return false;
    if (ENGLISH.has(w)) english++;
  }
  return english >= 2;
}

/**
 * Rewrites an English reply in Indonesian, preserving its content.
 *
 * Translating beats regenerating: the reply that slipped language was otherwise
 * correct and already consistent with whatever tool was called alongside it, so
 * asking the model for a fresh answer risks changing what it promised. Returns
 * "" if the call fails — the caller keeps the original rather than dropping the
 * customer's reply on the floor.
 */
export async function translateToIndonesian(text: string): Promise<string> {
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      ...NO_THINKING,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `Terjemahkan pesan berikut ke Bahasa Indonesia yang ramah dan kasual, sapaan "kak". Jangan tambah atau kurangi informasi. Jawab HANYA dengan hasil terjemahannya, tanpa penjelasan.\n\n"""\n${text}\n"""`,
        },
      ],
    });
    const out = res.content
      .filter(
        (b): b is { type: "text"; text: string; citations: never } =>
          b.type === "text",
      )
      .map((b) => b.text)
      .join("")
      .trim();
    return out.replace(/^"""\n?|\n?"""$/g, "").trim();
  } catch (err) {
    console.error("[language] translation failed:", (err as Error).message);
    return "";
  }
}
