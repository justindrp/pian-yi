import { claimsSkipDone } from "@/app/api/webhook/whatsapp/route";

// The route module pulls in the whole webhook dependency graph. Nothing here
// calls into it — `claimsSkipDone` is pure — so the mocks only need to exist.
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "x",
  HAIKU_MODEL: "x",
  NO_THINKING: {},
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");

describe("claimsSkipDone", () => {
  // The first of these is verbatim what Febby was answered on 2026-09-02, with
  // no delete_deliveries call behind it.
  it.each([
    "Bisa banget kak, masih sempat kok. Saya skip pengiriman Kamis besok dan lanjut lagi Jumat seperti biasa ya. Saya proses sekarang.",
    "Baik kak, Kamis di-skip ya, Jumat tetap jalan 😊",
    "Oke kak, saya pindahkan pengiriman Rabu ke Kamis ya.",
    "Siap kak, pengiriman besok saya batalkan ya.",
    // Nadya, 2026-09-07: a meal move confirmed and then taken back two lines
    // later. Weighed as one blob the word "dikunci" silenced the guard, and the
    // row was still dinner when the sheet went out. She had read the first line.
    "Bisa kak 😊 Untuk besok (Selasa 8 September), pengiriman kak Nadya diganti ke siang ya, jam 10.00-12.00 WIB. Sudah kami catet ya 🙏\n\nTapi mohon maaf kak, untuk besok sebenarnya sudah dikunci karena waktunya sudah lewat dari jam 16.00 WIB kemarin.",
    // Cindi, 2026-09-06: the same shape for an address, with a verb nothing
    // listed. Her lunch went to UPH Gate 2 twice more before it was caught.
    "Siap kak, untuk *Selasa 8 September* pengiriman dialihkan ke *Kost Platinum* ya. Jadwal di catatan kami memang sudah begitu kok, jadi aman.\n\nUntuk besok Senin tetap ke *UPH Gate 2* ya kak karena udah terkunci.",
    "Baik kak, alamat Rabu saya ubah ke kantor ya.",
  ])("matches a confirmed skip, move or re-address: %s", (reply) => {
    expect(claimsSkipDone(reply)).toBe(true);
  });

  // A refusal names the same verbs. Past the cutoff it is the correct answer,
  // and nothing was deleted because nothing should have been.
  it.each([
    "Maaf kak, Kamis tidak bisa di-skip karena pengirimannya sudah terkunci.",
    "Untuk skip pengiriman, kabari kami sebelum jam 16.00 sehari sebelumnya ya kak.",
    "Sisa kuota kakak 2 porsi ya, terjadwal Jumat 4 September.",
    "Baik kak, terima kasih ya 😊",
    // A refusal only cancels the claim standing next to it, and here it does:
    // both halves of this one say the same thing.
    "Maaf kak, alamat untuk besok sudah tidak bisa diubah karena pengirimannya terkunci.",
  ])("does not match: %s", (reply) => {
    expect(claimsSkipDone(reply)).toBe(false);
  });
});
