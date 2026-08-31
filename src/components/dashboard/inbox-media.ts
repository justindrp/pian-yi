/**
 * How a `conversations` row that carries a file turns into something the inbox
 * can draw. Extracted from `inbox-client.tsx` so the shapes can be tested: five
 * years of rows are written by four different senders and no two agree on where
 * the URL lives.
 */

/**
 * Pulls the object path out of a Supabase storage URL, encoded for use in our
 * proxy route. Returns null when the URL is not for that bucket.
 */
export function getStoragePath(
  content: string | null | undefined,
  bucket: string,
) {
  if (!content?.startsWith("https://")) return null;
  const path = content.split(`/${bucket}/`)[1];
  if (!path) return null;
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

type DocumentRow = {
  content: string | null;
  message_type?: string | null;
  media_id?: string | null;
  media_url?: string | null;
};

/** `[Dokumen: Invoice.pdf] Terlampir ya kak` — the webhook's inbound shape. */
const DOC_PREFIX = /^\[Dokumen:\s*(.+?)\]\s*/;

/** Storage prefixes every upload path adds: `1788165486331-Invoice.pdf`. */
function prettyFilename(url: string) {
  return decodeURIComponent(url.split("/").pop() ?? "").replace(/^\d+-/, "");
}

export function getInboxDocument(msg: DocumentRow) {
  if (msg.message_type !== "document") return null;

  const prefixed = msg.content?.match(DOC_PREFIX)?.[1]?.trim();

  const storedPath =
    getStoragePath(msg.media_url, "chat-media") ??
    getStoragePath(msg.content, "chat-media");
  if (storedPath) {
    return {
      href: `/api/inbox/chat-media/${storedPath}`,
      label: decodeURIComponent(storedPath.split("/").pop() ?? "") || "Dokumen",
    };
  }

  // media_url first, then content — the image path already reads both, this one
  // only read content. An outbound document keeps its caption in content and
  // the file URL in media_url, so a PDF sent from a script was invisible:
  // Carolin's invoice went out on 2026-08-30, WhatsApp marked it read, and the
  // inbox showed the caption bubble with no attachment under it. Any bucket
  // counts. The two proxied buckets are handled above; a file uploaded anywhere
  // else is still a public URL we can link straight to.
  //
  // This is checked before media_id because Meta deletes media after about a
  // week and our own copy does not expire.
  for (const candidate of [msg.media_url, msg.content]) {
    if (!candidate?.startsWith("https://")) continue;
    return {
      href: candidate,
      label: prefixed || prettyFilename(candidate) || "Dokumen",
    };
  }

  if (msg.media_id) {
    // Only the filename, never the caption behind it: the label used to be the
    // whole `content` with the `[Dokumen: …]` brackets stripped, which drew the
    // file name welded to the message — "Invoice-PianYi-ICEBSD.pdfInvoice
    // INV/PY/2026-08/001 - Pian Yi Catering - Rp 3.600.000" — as one link.
    return {
      href: `/api/inbox/media/${msg.media_id}`,
      label: prefixed || "Dokumen",
    };
  }
  return null;
}

/**
 * The message sent alongside the file, if any.
 *
 * A document bubble drew the attachment and nothing else, so the words that went
 * with it were on the customer's phone and nowhere in the inbox — the same hole
 * captions had for images. Three invoices went out that way on 30–31 Agustus,
 * each with a summary of what was being charged that no admin could read back.
 */
export function getInboxDocumentCaption(msg: DocumentRow) {
  if (msg.message_type !== "document") return null;
  const text = msg.content?.replace(DOC_PREFIX, "").trim();
  if (!text || text.startsWith("https://")) return null;
  return text;
}
