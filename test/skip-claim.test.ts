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
  ])("matches a confirmed skip or move: %s", (reply) => {
    expect(claimsSkipDone(reply)).toBe(true);
  });

  // A refusal names the same verbs. Past the cutoff it is the correct answer,
  // and nothing was deleted because nothing should have been.
  it.each([
    "Maaf kak, Kamis tidak bisa di-skip karena pengirimannya sudah terkunci.",
    "Untuk skip pengiriman, kabari kami sebelum jam 16.00 sehari sebelumnya ya kak.",
    "Sisa kuota kakak 2 porsi ya, terjadwal Jumat 4 September.",
    "Baik kak, terima kasih ya 😊",
  ])("does not match: %s", (reply) => {
    expect(claimsSkipDone(reply)).toBe(false);
  });
});
