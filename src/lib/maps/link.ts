/**
 * A Google Maps link, wherever it came from.
 *
 * `www.google.com/maps?q=lat,lng` is in the list because that is the link
 * *we* write: a shared WhatsApp location has no text, so the webhook renders
 * it as `[Lokasi dibagikan: …]` plus that URL (`formatLocationMessage()`).
 * The old pattern matched only the three links a customer pastes by hand, so
 * a customer who dropped a pin — the easiest thing to ask for and the most
 * accurate thing to receive — was read as having sent no link at all.
 *
 * `share.google/<id>` is the short link the Google app now hands out from its
 * own Bagikan sheet. It resolves to a search result rather than to Maps, so it
 * is a weaker link than the rest — but four customers already had one stored
 * in `google_maps_link`, and because `extract_order` re-parses that column
 * through this pattern rather than testing it for emptiness, a stored
 * share.google link read as *no link on file*: Sherine Fayola was asked for
 * her pin twice on 2026-09-21 and her 40-porsi renewal was withheld both
 * times. Matching it is what makes the on-file check see a link that is there.
 */
export const MAPS_LINK_RE =
  /https?:\/\/(?:maps\.app\.goo\.gl|share\.google|goo\.gl\/maps|maps\.google\.[a-z.]+\/\S*|(?:www\.)?google\.[a-z.]+\/maps\S*)\S*/i;

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
 * address given — for the order gate and for the prompt, which since
 * 2026-09-23 checks the place the pin names against the typed address once
 * instead of asking for a dragged link on every turn.
 * `formatLocationMessage()` writes exactly one shape —
 * `google.com/maps?q=<lat>,<lng>` — so the two are told apart by that.
 */
export function isSharedPinLink(url: string): boolean {
  return /google\.[a-z.]+\/maps\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/i.test(
    url.trim(),
  );
}
