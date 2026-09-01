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
