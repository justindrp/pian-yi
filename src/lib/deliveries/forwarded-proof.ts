/**
 * Proof Relay — a delivery photo forwarded to the WABA by an admin's own
 * handset, relayed on to the customer named in the caption.
 *
 * The kitchens have always been able to do this — `handleSubcontractorMessage`
 * recognises `subcontractors.admin_phone` and runs the photo through
 * `matchDeliveryPhoto`. An owner who took the photo themselves had no path:
 * their number is an ordinary `customers` row, so the image fell through to
 * `handlePaymentProofImage` and the bot answered it as if a customer had sent
 * a transfer receipt.
 *
 * The caption is the whole interface: one customer name, and the photo goes to
 * that customer. Matching is deliberately NOT the Haiku matcher the kitchens
 * get. That model call exists because a kitchen caption is prose written in a
 * hurry ("pesanan bu ani alsut, yg tanpa sapi"); a name typed by an admin needs
 * no inference, and inference is exactly what must not happen here — a 0.95
 * confidence that lands on the wrong row sends one customer a photo of another
 * customer's food. So: match, or refuse and say why. Ambiguity is answered with
 * the candidate names, in the same chat, which is a faster correction than a
 * push notification to a screen nobody is looking at.
 */

import { getSetting } from "@/lib/cache/settings";
import { sendDeliveryPhotoToCustomer } from "@/lib/claude/photo-matcher";
import { logEdit, systemActor } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { jakartaDateString } from "@/lib/menu/week";
import { downloadMedia, sendTextMessage } from "@/lib/whatsapp/client";
import { hoursSinceInbound } from "@/lib/whatsapp/window";
import type { WhatsAppMessage } from "@/lib/whatsapp/types";

export interface ProofCandidate {
  customerId: string;
  name: string;
}

export type CaptionMatch =
  | { ok: true; customerId: string; name: string; fuzzy: boolean }
  | { ok: false; reason: "empty" | "none" | "ambiguous"; candidates: string[] };

/** Edit distance. Same routine `scripts/audit-sheet-data.ts` uses to suggest names. */
function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/**
 * How wrong a caption may be and still count. One character per four, floor 1,
 * so "clarine" reaches "Clairine" (1) and "veronika" reaches "Veronica" (2)
 * while a three-letter caption still has to be spelled right. Scaling matters:
 * a flat tolerance of 2 makes "ani", "andi" and "adi" the same word.
 */
function typoTolerance(q: string): number {
  return Math.max(1, Math.floor(q.length / 4));
}

/** Lowercase, strip everything that is not a letter, digit or space, collapse runs. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Resolves a caption to one of today's customers.
 *
 * Three passes, each stricter than the next is loose: whole-string equality,
 * then "every word in the caption starts a word in the name" (so "clairine"
 * finds "Clairine Aurelia" and "kurniadi tan" finds "Kurniadi Tan"), then
 * substring. The first pass that yields exactly one customer wins; a pass that
 * yields several stops the search rather than falling through to a looser one,
 * because a looser pass cannot un-ambiguate what a stricter one could not tell
 * apart.
 */
export function matchCaption(
  caption: string | null | undefined,
  candidates: ProofCandidate[],
): CaptionMatch {
  const q = normalize(caption ?? "");
  if (!q) return { ok: false, reason: "empty", candidates: [] };

  const names = candidates.map((c) => ({ ...c, norm: normalize(c.name) }));
  const words = q.split(" ");

  const passes: ((n: (typeof names)[number]) => boolean)[] = [
    (n) => n.norm === q,
    (n) => {
      const parts = n.norm.split(" ");
      return words.every((w) => parts.some((p) => p.startsWith(w)));
    },
    (n) => n.norm.includes(q) || q.includes(n.norm),
  ];

  for (const pass of passes) {
    const hits = names.filter(pass);
    const unique = [...new Map(hits.map((h) => [h.customerId, h])).values()];
    if (unique.length === 1)
      return {
        ok: true,
        customerId: unique[0].customerId,
        name: unique[0].name,
        fuzzy: false,
      };
    if (unique.length > 1)
      return {
        ok: false,
        reason: "ambiguous",
        candidates: unique.map((u) => u.name),
      };
  }

  // Last pass: a misspelling. Distance is measured against the whole name and
  // against each of its words, so "clarine" reaches "Clairine Aurelia" through
  // its first name. Only ever reached when the exact passes found nothing, and
  // still refuses on a tie — a typo that fits two people is not a typo we can
  // resolve. The ack names whoever it landed on, which is the real check.
  const tolerance = typoTolerance(q);
  const near = names
    .map((n) => ({
      ...n,
      distance: Math.min(
        lev(q, n.norm),
        ...n.norm.split(" ").map((w) => lev(q, w)),
      ),
    }))
    .filter((n) => n.distance <= tolerance);

  const byCustomer = [
    ...new Map(
      near
        .sort((a, b) => a.distance - b.distance)
        .map((n) => [n.customerId, n]),
    ).values(),
  ];

  if (byCustomer.length === 1)
    return {
      ok: true,
      customerId: byCustomer[0].customerId,
      name: byCustomer[0].name,
      fuzzy: true,
    };

  if (byCustomer.length > 1) {
    const best = Math.min(...byCustomer.map((n) => n.distance));
    const winners = byCustomer.filter((n) => n.distance === best);
    if (winners.length === 1)
      return {
        ok: true,
        customerId: winners[0].customerId,
        name: winners[0].name,
        fuzzy: true,
      };
    return {
      ok: false,
      reason: "ambiguous",
      candidates: winners.map((w) => w.name),
    };
  }

  return {
    ok: false,
    reason: "none",
    candidates: candidates.map((c) => c.name),
  };
}

/** The phones allowed to forward, from `settings.proof_forwarder_phones`. */
export async function proofForwarders(): Promise<string[]> {
  const raw = await getSetting("proof_forwarder_phones");
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export async function isProofForwarder(phone: string): Promise<boolean> {
  return (await proofForwarders()).includes(phone);
}

/** Every customer with a delivery row today, across all kitchens, deduped. */
async function todaysCustomers(): Promise<ProofCandidate[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("daily_deliveries")
    .select("customer_id, customers(name)")
    .eq("delivery_date", jakartaDateString());

  const seen = new Map<string, ProofCandidate>();
  for (const row of (data ?? []) as unknown as {
    customer_id: string;
    customers: { name: string | null } | null;
  }[]) {
    const name = row.customers?.name;
    if (name && !seen.has(row.customer_id))
      seen.set(row.customer_id, { customerId: row.customer_id, name });
  }
  return [...seen.values()];
}

/**
 * The warning appended to the ack when the photo went to a closed window.
 *
 * A `delivery_proof` template send returns 200 `accepted` whatever the window
 * says; the refusal arrives later in the status webhook, where nobody is
 * watching. So the ack cannot report what happened — it reports what is about
 * to happen, and names the number to finish the job by hand. Of 30 proofs sent
 * 20–31 Agustus, the 18 that failed were exactly the 18 whose customer had not
 * spoken in the previous 24 hours. See "No payment method on the WABA" in
 * `docs/WHATSAPP.md`.
 *
 * Empty string when the window is open, so the ack stays one line on the days
 * nothing is wrong.
 */
export function windowWarning(params: {
  name: string;
  phone: string;
  hours: number;
  manualNumber: string;
}): string {
  if (params.hours < 24) return "";

  const since = Number.isFinite(params.hours)
    ? params.hours < 48
      ? `${Math.floor(params.hours)} jam lalu`
      : `${Math.floor(params.hours / 24)} hari lalu`
    : "belum pernah chat ke nomor ini";

  return `\n\n⚠️ Window 24 jam ${params.name} sudah tutup (${since}), jadi foto ini kemungkinan besar tidak sampai. Kirim manual dari ${params.manualNumber} ke ${params.phone}.`;
}

/**
 * Handles one forwarded image. Returns the text sent back to the forwarder, so
 * the webhook test can assert on it without reading WhatsApp.
 *
 * The ack says the photo was handed to WhatsApp, never that it arrived: a
 * template send returns 200 `accepted` and its failure — `131042`, or a closed
 * window — only turns up later in the status webhook. See "The 24-hour window"
 * in docs/WHATSAPP.md.
 */
export async function handleForwardedProof(
  message: WhatsAppMessage,
): Promise<string> {
  const db = createAdminClient();

  const say = async (text: string): Promise<string> => {
    await sendTextMessage(message.from, text).catch((err) =>
      console.error("[forwarded-proof] ack failed:", (err as Error).message),
    );
    return text;
  };

  if (!message.imageCaption?.trim())
    return say(
      "Fotonya belum ada caption. Kirim ulang dengan nama pelanggan di caption ya.",
    );

  const candidates = await todaysCustomers();
  if (candidates.length === 0)
    return say("Belum ada pengiriman terjadwal hari ini, jadi fotonya belum bisa dicocokkan.");

  const match = matchCaption(message.imageCaption, candidates);
  if (!match.ok) {
    const list = match.candidates.slice(0, 12).join(", ");
    return say(
      match.reason === "ambiguous"
        ? `"${message.imageCaption}" cocok dengan ${match.candidates.length} orang: ${list}. Kirim ulang dengan nama lengkapnya.`
        : `"${message.imageCaption}" tidak cocok dengan pengiriman hari ini. Yang terjadwal: ${list}.`,
    );
  }

  let image: Buffer;
  try {
    image = await downloadMedia(message.imageId ?? "");
  } catch (err) {
    console.error("[forwarded-proof] download failed:", (err as Error).message);
    return say("Fotonya gagal diunduh dari WhatsApp. Coba kirim ulang ya.");
  }

  const storagePath = `forwarded/${jakartaDateString()}/${message.messageId}.jpg`;
  const { error: uploadErr } = await db.storage
    .from("delivery-proofs")
    .upload(storagePath, image, { contentType: "image/jpeg", upsert: false });
  if (uploadErr) {
    console.error("[forwarded-proof] upload failed:", uploadErr.message);
    return say("Fotonya gagal disimpan. Coba kirim ulang ya.");
  }

  const { data: urlData } = db.storage
    .from("delivery-proofs")
    .getPublicUrl(storagePath);

  const { data: proof } = await db
    .from("delivery_proofs")
    .insert({
      sender_phone: message.from,
      subcontractor_id: null,
      whatsapp_message_id: message.messageId,
      caption: message.imageCaption,
      image_url: urlData.publicUrl,
      status: "pending",
    })
    .select("id")
    .single();

  if (!proof) return say("Fotonya gagal dicatat. Coba kirim ulang ya.");

  const sentBy = `forward:${message.from}`;
  await sendDeliveryPhotoToCustomer(proof.id, match.customerId, undefined, sentBy);
  await db
    .from("delivery_proofs")
    .update({
      matched_customer_id: match.customerId,
      match_confidence: 1,
      match_method: "forwarded_caption",
      status: "auto_sent",
      sent_to_customer_at: new Date().toISOString(),
      sent_by: sentBy,
    })
    .eq("id", proof.id);

  await logEdit({
    db,
    actor: systemActor("forwarded-proof"),
    entityType: "delivery_proofs",
    entityId: proof.id,
    action: "send",
    changes: {
      forwarded_by: message.from,
      caption: message.imageCaption,
      matched_customer_id: match.customerId,
      matched_name: match.name,
    },
  });

  const [hours, manualNumber, { data: customer }] = await Promise.all([
    hoursSinceInbound(match.customerId),
    getSetting("whatsapp_manual_number"),
    db
      .from("customers")
      .select("phone_number")
      .eq("id", match.customerId)
      .single(),
  ]);

  const sent =
    match.fuzzy
      ? `Terkirim ke ${match.name} (caption "${message.imageCaption}").`
      : `Terkirim ke ${match.name}.`;

  return say(
    sent +
      windowWarning({
        name: match.name,
        phone: customer?.phone_number ?? "-",
        hours,
        manualNumber: manualNumber || "nomor kedua",
      }),
  );
}
