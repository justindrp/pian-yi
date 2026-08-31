import { claimsMenuSent, claimsProofSent } from "@/app/api/webhook/whatsapp/route";

// The route module pulls in the whole webhook dependency graph. Nothing here
// calls into it — `claimsProofSent` is pure — so the mocks only need to exist.
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "x",
  HAIKU_MODEL: "x",
  NO_THINKING: {},
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");

describe("claimsProofSent", () => {
  it("catches the reply Clairine got on 2026-08-31", () => {
    expect(
      claimsProofSent(
        "Halo kak Clairine! Iya, pesananmu sudah diantar hari ini, dan kami sudah kirimkan foto buktinya ya kak 😊 Semoga menikmati makan malamnya!",
      ),
    ).toBe(true);
  });

  it("catches the reply that followed her explicit request", () => {
    // 11:19:20, thirty seconds after "Bukti pengantaran nya kak". The menu
    // recovery fired on this one and sent her the weekly menu instead.
    expect(
      claimsProofSent(
        "Iya kak, foto bukti pengantarannya sudah kami kirimkan di chat ini ya 😊",
      ),
    ).toBe(true);
  });

  it.each([
    "foto buktinya sudah kami kirim ya kak",
    "bukti pengirimannya sudah saya kirimkan kak",
    "berikut foto pengirimannya ya kak",
    "terlampir bukti pengiriman hari ini",
    "sudah saya share bukti pengirimannya kak",
  ])("treats %p as a claim", (reply) => {
    expect(claimsProofSent(reply)).toBe(true);
  });

  it.each([
    // A promise about a later turn is still true when nothing goes out now.
    "Fotonya nanti saya kirim ya kak setelah dapur upload",
    "bukti pengirimannya menyusul ya kak",
    // Saying there is none is the honest answer, not a claim.
    "Belum ada foto pengiriman untuk hari ini kak, saya cek ke tim dulu ya",
    // The customer is the one who sent something.
    "Baik kak, sudah saya terima bukti transfernya",
    // Ordinary delivery talk with no photo in it.
    "Pesanan kakak sudah diantar hari ini ya",
  ])("treats %p as no claim", (reply) => {
    expect(claimsProofSent(reply)).toBe(false);
  });

  it("does not fire on a menu claim", () => {
    expect(claimsProofSent("menu minggu ini sudah saya kirim gambarnya ya kak")).toBe(
      false,
    );
  });

  it("owns a reply the menu claim would also have matched", () => {
    // "berikut ... foto" reads as a menu claim; the customer asked for their
    // delivery photo, so the menu recovery stands down and this one runs.
    const reply = "Berikut foto pengirimannya ya kak";
    expect(claimsMenuSent(reply)).toBe(true);
    expect(claimsProofSent(reply)).toBe(true);
  });
});
