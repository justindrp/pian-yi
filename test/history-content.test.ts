import { historyContent } from "@/lib/claude/conversation";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

const MENU_URL =
  "https://mtepdwekiifqdtzhqoys.supabase.co/storage/v1/object/public/menu-images/subcontractors/52cd5e62-da09-49c9-939c-2f1246566c40/1786636411403.jpg";

describe("historyContent", () => {
  // Tagged `sistem:` on purpose. The untagged "[gambar terkirim ke customer]"
  // read as assistant prose and the model started writing it itself instead of
  // calling send_menu_image — see the comment on historyContent.
  it("hides the URL of an image we sent, marked as a system note", () => {
    expect(
      historyContent({
        role: "assistant",
        content: MENU_URL,
        message_type: "image",
      }),
    ).toBe("[sistem: gambar sudah terkirim ke customer]");
  });

  it("hides the URL of an image the customer sent", () => {
    expect(
      historyContent({
        role: "user",
        content: MENU_URL,
        message_type: "image",
      }),
    ).toBe("[customer mengirim gambar]");
  });

  it("keeps a caption on a media message", () => {
    expect(
      historyContent({
        role: "user",
        content: "ini bukti transfernya kak",
        message_type: "image",
      }),
    ).toBe("ini bukti transfernya kak");
  });

  it("keeps the placeholder labels already written by the webhook", () => {
    expect(
      historyContent({
        role: "user",
        content: "[Bukti pembayaran dikirim]",
        message_type: "image",
      }),
    ).toBe("[Bukti pembayaran dikirim]");
  });

  it("leaves text messages alone, even ones containing a link", () => {
    const maps = "lokasi saya https://maps.app.goo.gl/abc123";
    expect(
      historyContent({ role: "user", content: maps, message_type: "text" }),
    ).toBe(maps);
  });

  it("leaves a bare link in a text message alone", () => {
    // A maps pin arrives as text, and the bot fills it into the order form.
    const pin = "https://maps.app.goo.gl/abc123";
    expect(
      historyContent({ role: "user", content: pin, message_type: null }),
    ).toBe(pin);
  });
});
