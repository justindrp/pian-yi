/**
 * `settings.proof_forwarder_phones` — our own handsets.
 *
 * The name says "proof forwarder" because relaying a delivery photo is what
 * the list was added for (migration 083), but what it actually means to the
 * webhook is wider: a number on this list is never a customer. The customer
 * upsert sits behind the check in `src/app/api/webhook/whatsapp/route.ts`, so
 * a listed handset gets no bot reply, no `customers` row and no welcome
 * sequence — only an image is acted on, as a proof to relay.
 *
 * That is also why the reporting scripts read it: without the filter a staff
 * handset that once chatted the bot keeps surfacing in `review-leads` and
 * `review-chats` as a prospect nobody can sell to. Jennifer, Justin's personal
 * assistant, was one of the 8 "leads" in the 20-21 September review.
 *
 * It lives here rather than in `forwarded-proof.ts` so a script can ask the
 * question without importing the photo matcher and the Anthropic SDK behind it.
 */
import { getSetting } from "@/lib/cache/settings";

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
