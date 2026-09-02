/**
 * A Google Maps link, wherever it came from.
 *
 * `www.google.com/maps?q=lat,lng` is in the list because that is the link
 * *we* write: a shared WhatsApp location has no text, so the webhook renders
 * it as `[Lokasi dibagikan: …]` plus that URL (`formatLocationMessage()`).
 * The old pattern matched only the three links a customer pastes by hand, so
 * a customer who dropped a pin — the easiest thing to ask for and the most
 * accurate thing to receive — was read as having sent no link at all.
 */
export const MAPS_LINK_RE =
  /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.[a-z.]+\/\S*|(?:www\.)?google\.[a-z.]+\/maps\S*)\S*/i;

/** The first Maps link in `text`, or null. */
export function findMapsLink(text: string): string | null {
  return text.match(MAPS_LINK_RE)?.[0] ?? null;
}

/**
 * Whether a link is one *we* rendered from a shared WhatsApp location, rather
 * than one the customer picked in Google Maps.
 *
 * A WhatsApp share-location is wherever the sender's phone thinks it is when
 * they tap it, and that is not always where the food goes. +6281299221430 sent
 * one on 2026-09-02 and had to say so themselves: "Alamatku kl di sharelok
 * adanya di kampung sebelah ka, krn posisi rumahnya bersebelahan sama kampung
 * sebelah — jadi gak bisa sesuai titik ka." The link still counts as an
 * address given and is still worth storing, but the bot must go on asking for
 * a Google Maps link, which the customer drags onto the right point before
 * copying. `formatLocationMessage()` writes exactly one shape —
 * `google.com/maps?q=<lat>,<lng>` — so the two are told apart by that.
 */
export function isSharedPinLink(url: string): boolean {
  return /google\.[a-z.]+\/maps\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/i.test(
    url.trim(),
  );
}
