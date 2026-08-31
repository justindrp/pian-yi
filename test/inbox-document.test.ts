import {
  getInboxDocument,
  getInboxDocumentCaption,
} from "@/components/dashboard/inbox-media";

const BUCKET = "https://xyz.supabase.co/storage/v1/object/public/menu-images";

describe("getInboxDocument", () => {
  test("ignores rows that are not documents", () => {
    expect(
      getInboxDocument({ content: "halo kak", message_type: "text" }),
    ).toBeNull();
  });

  // The shape sendInvoice and manual-document write now: caption in content,
  // file in media_url.
  test("links the file in media_url and names it from the URL", () => {
    const doc = getInboxDocument({
      content: "Invoice INV/PY/2026-09/0001 — Pian Yi Catering",
      message_type: "document",
      media_url: `${BUCKET}/invoices/cust/1788165486331-INV-PY-2026-09-0001.pdf`,
    });
    expect(doc).toEqual({
      href: `${BUCKET}/invoices/cust/1788165486331-INV-PY-2026-09-0001.pdf`,
      label: "INV-PY-2026-09-0001.pdf",
    });
  });

  // Rows written before media_url was filled in: the URL is the content.
  test("falls back to a URL stored as the content", () => {
    const doc = getInboxDocument({
      content: `${BUCKET}/inbox/cust/1786271133697-Pian_Yi_Catering.pdf`,
      message_type: "document",
    });
    expect(doc?.label).toBe("Pian_Yi_Catering.pdf");
  });

  test("proxies a chat-media file rather than linking the bucket", () => {
    const doc = getInboxDocument({
      content: "[Dokumen: bukti.pdf]",
      message_type: "document",
      media_url:
        "https://xyz.supabase.co/storage/v1/object/public/chat-media/inbound/bukti.pdf",
    });
    expect(doc?.href).toBe("/api/inbox/chat-media/inbound/bukti.pdf");
  });

  // The label was `content` with the brackets stripped, which drew the file
  // name welded to the caption as one link.
  test("labels a media_id row with the filename alone, not the caption", () => {
    const doc = getInboxDocument({
      content:
        "[Dokumen: Invoice-PianYi-ICEBSD.pdf] Invoice INV/PY/2026-08/001 - Rp 3.600.000",
      message_type: "document",
      media_id: "1515371410623775",
    });
    expect(doc).toEqual({
      href: "/api/inbox/media/1515371410623775",
      label: "Invoice-PianYi-ICEBSD.pdf",
    });
  });

  test("names an unnamed media_id row Dokumen", () => {
    const doc = getInboxDocument({
      content: "Invoice INV/PY/2026-08/001 - versi terbaru",
      message_type: "document",
      media_id: "1383256020539470",
    });
    expect(doc?.label).toBe("Dokumen");
  });

  // Our own copy outlives Meta's, which is deleted after about a week.
  test("prefers our stored copy over the media proxy", () => {
    const doc = getInboxDocument({
      content: "[Dokumen: invoice.pdf]",
      message_type: "document",
      media_id: "999",
      media_url: `${BUCKET}/inbox/cust/1-invoice.pdf`,
    });
    expect(doc?.href).toBe(`${BUCKET}/inbox/cust/1-invoice.pdf`);
  });

  test("returns null when the row carries no file at all", () => {
    expect(
      getInboxDocument({
        content: "invoice menyusul",
        message_type: "document",
      }),
    ).toBeNull();
  });
});

describe("getInboxDocumentCaption", () => {
  test("returns the message sent with the file", () => {
    expect(
      getInboxDocumentCaption({
        content: "Halo kak Carolin 🙏 Invoice-nya sudah kami perbaiki.",
        message_type: "document",
        media_url: `${BUCKET}/inbox/cust/1-invoice.pdf`,
      }),
    ).toBe("Halo kak Carolin 🙏 Invoice-nya sudah kami perbaiki.");
  });

  test("strips the [Dokumen: …] prefix", () => {
    expect(
      getInboxDocumentCaption({
        content: "[Dokumen: Invoice.pdf] Invoice INV/PY/2026-08/001",
        message_type: "document",
        media_id: "1",
      }),
    ).toBe("Invoice INV/PY/2026-08/001");
  });

  test("has nothing to say when the content is only the file", () => {
    expect(
      getInboxDocumentCaption({
        content: `${BUCKET}/inbox/cust/1-invoice.pdf`,
        message_type: "document",
      }),
    ).toBeNull();
    expect(
      getInboxDocumentCaption({
        content: "[Dokumen: Invoice.pdf]",
        message_type: "document",
        media_id: "1",
      }),
    ).toBeNull();
  });
});
