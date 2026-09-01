import { claimsMenuSent } from "@/app/api/webhook/whatsapp/route";
import { sanitizeReply } from "@/lib/claude/sanitize-reply";

// The route module pulls in the whole webhook dependency graph. Nothing here
// calls into it — `claimsMenuSent` is pure — so the mocks only need to exist.
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "x",
  HAIKU_MODEL: "x",
  NO_THINKING: {},
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");

describe("claimsMenuSent", () => {
  // Both of these went to ****7277 on 2026-08-26 with no send_menu_image call
  // behind them. Neither matched the old pattern, which required
  // "sudah|udah|telah" — the past tense of the lie, and not the one it told.
  it.each([
    "Tentu kak, boleh banget liat-lihat dulu. Berikut menu gambar untuk minggu ini (Senin 24 – Sabtu 29 Agustus 2026) saya kirimkan ya.\n\n[gambar menu terkirim]",
    "Oh iya kak, maaf. Saya kirimkan lagi menu minggu ini (Senin 24 – Sabtu 29 Agustus 2026) sekarang ya.\n\n[gambar menu terkirim]",
  ])("catches the reply that fooled the old pattern: %#", (reply) => {
    expect(claimsMenuSent(reply)).toBe(true);
  });

  it.each([
    "menu minggu ini sudah saya kirim gambarnya ya kak",
    "gambar menunya udah kami kirimkan kak",
    "menunya saya kirimkan ya kak",
    "saya kirimkan menu minggu ini ya",
    "saya share price list nya ya kak",
    "Ini dia menunya kak",
    "Terlampir menu minggu ini ya kak",
    "[gambar menu terkirim]",
    "[foto menu dikirim]",
  ])("treats %p as a claim", (reply) => {
    expect(claimsMenuSent(reply)).toBe(true);
  });

  it.each([
    // A promise about a later turn is still true when nothing goes out now.
    "Menunya nanti saya kirim ya kak setelah dapur update",
    "Menu minggu depan menyusul ya kak",
    "besok saya kirimkan menunya kak",
    // Ordinary replies that mention the menu without claiming anything.
    "Menu kami rotasi harian kak, ada pilihan tanpa pedas juga",
    "Boleh tahu mau berapa porsi kak?",
    // The customer is the one sending something.
    "Baik kak, sudah saya terima bukti transfernya",
  ])("treats %p as no claim", (reply) => {
    expect(claimsMenuSent(reply)).toBe(false);
  });

  it("still fires when one reply defers next week's menu and claims this week's", () => {
    // The deferred half is cut, not used to veto the whole reply.
    expect(
      claimsMenuSent(
        "Menu minggu ini saya kirimkan ya kak. Untuk minggu depan nanti saya kirim kalau sudah keluar.",
      ),
    ).toBe(true);
  });

  it("is not left stateful by the global flags inside it", () => {
    // MENU_SEND_DEFERRED and the stage-direction pattern are both /g. If their
    // lastIndex leaked, a repeated call would flip its answer.
    const reply = "[gambar menu terkirim]";
    expect(claimsMenuSent(reply)).toBe(true);
    expect(claimsMenuSent(reply)).toBe(true);
    expect(claimsMenuSent(reply)).toBe(true);
  });

  // The webhook runs this guard on sanitizeReply(replyText), not on the raw
  // model output, so these are the pairs that decide whether an image goes out.
  describe("what the customer actually reads", () => {
    it("does not fire on a claim the sanitizer deleted", () => {
      // Clairine Aurelia, 2026-09-01: she asked whether today's delivery had
      // arrived, got her delivery photo, and then this week's menu on top of
      // it. The visible reply claims nothing about a menu — the match lived
      // entirely in a bracket the customer never saw.
      const raw =
        "Maaf kak, aku salah bilang kalau kiriman hari ini udah sampai.\n\n[Internal: gambar menu terkirim]\n\nKalau kakak mau aku carikan bukti fotonya, aku bantu cek ya.";
      expect(claimsMenuSent(raw)).toBe(true);
      expect(claimsMenuSent(sanitizeReply(raw))).toBe(false);
    });

    it("still fires when the visible text carries the claim too", () => {
      // The ****7277 reply: the stage direction goes, the sentence stays, and
      // the customer is still looking for an image. Recovery must survive the
      // sanitizer.
      const raw =
        "Tentu kak. Berikut menu gambar untuk minggu ini saya kirimkan ya.\n\n[gambar menu terkirim]";
      expect(claimsMenuSent(sanitizeReply(raw))).toBe(true);
    });
  });
});
