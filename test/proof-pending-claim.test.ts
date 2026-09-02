import { claimsProofPending } from "@/app/api/webhook/whatsapp/route";

// The route module pulls in the whole webhook dependency graph. Nothing here
// calls into it — `claimsProofPending` is pure — so the mocks only need to
// exist.
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "x",
  HAIKU_MODEL: "x",
  NO_THINKING: {},
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");

const ASKED = "kak cateringnya udh dianter?";

describe("claimsProofPending — the stall", () => {
  // Every one of these went to Naya on 2026-09-02 between 11:09 and 11:55,
  // with no send_delivery_proof call behind any of them. She was in the lobby
  // of a building that will not take a hand-off, and the food had not been
  // delivered.
  it.each([
    "Kak, saya cek foto pengirimannya dulu ya.",
    "Kak, saya cek foto pengirimannya sekarang ya.",
    "Kak, mohon maaf atas kelamaannya, saya cari dulu bukti foto pengirimannya sekarang.",
    "Aku lihat dulu bukti pengirimannya ya kak.",
    "Bukti pengirimannya saya cek dulu ya kak.",
    "Foto pengirimannya sedang saya periksa kak.",
  ])("treats %p as a stall", (reply) => {
    expect(claimsProofPending(reply, ASKED)).toBe(true);
  });

  // The reply that does the thing instead of announcing it. Both of these are
  // the send claim, which claimsProofSent owns and which recovers through the
  // same guard — they must not depend on the customer having asked.
  it("does not fire on a reply that names no proof", () => {
    expect(
      claimsProofPending("Saya cek dulu jadwal pengiriman kakak ya", ASKED),
    ).toBe(false);
  });

  it("ignores a question about checking", () => {
    expect(
      claimsProofPending("Mau saya cek foto pengirimannya kak?", ASKED),
    ).toBe(false);
  });
});

describe("claimsProofPending — the invented arrival", () => {
  it.each([
    "Anterannya udah sampai kak, tunggu di lobby ya.",
    "Pesanan kakak sudah diantar hari ini ya.",
    "Makanannya sudah sampai kak.",
  ])("treats %p as a claim when the customer asked", (reply) => {
    expect(claimsProofPending(reply, ASKED)).toBe(true);
  });

  // The customer is the one saying it arrived. Answering "makanannya belum
  // sampai" off a photo the kitchen never uploaded contradicts the person who
  // is holding the food.
  it("leaves the arrival alone when the customer reported it", () => {
    expect(
      claimsProofPending(
        "Syukur kalau begitu kak. Makanannya sudah sampai ya, terima kasih sudah konfirmasi.",
        "udah sampai kak makasih",
      ),
    ).toBe(false);
  });

  it("leaves a conditional alone", () => {
    expect(
      claimsProofPending(
        "Kalau makanannya sudah sampai, kabari aku ya kak.",
        ASKED,
      ),
    ).toBe(false);
  });

  it("leaves a question alone", () => {
    expect(
      claimsProofPending("Apakah makanannya sudah sampai kak?", ASKED),
    ).toBe(false);
  });
});
