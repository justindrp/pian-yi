import { promisesSchedule } from "@/app/api/webhook/whatsapp/route";

// The route module pulls in the whole webhook dependency graph. Nothing here
// calls into it — `promisesSchedule` is pure — so the mocks only need to exist.
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "x",
  HAIKU_MODEL: "x",
  NO_THINKING: {},
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");

describe("promisesSchedule", () => {
  it("catches the delivery-verb shape that lost Fahmi's Monday", () => {
    expect(
      promisesSchedule(
        "Baik kak, saya jadwalkan pengiriman mulai Senin 24 Agustus ya.",
      ),
    ).toBe(true);
  });

  // Vania, 2026-08-30. The dates are a bulleted confirmation and the promise is
  // two sentences below them, so no delivery verb sits within 60 characters of
  // a date and the old pattern matched nothing. Three dinners never booked.
  it("catches a booking promise whose dates are in another sentence", () => {
    expect(
      promisesSchedule(
        "Baik kak Vania, Kakak mau pesan makan malam untuk:\n\n- Selasa, 1 September\n- Rabu, 2 September\n- Jumat, 4 September\n\nTotal 3 porsi makan malam dari Dapur 1. Semua tanggal itu hari kerja dan kami buka ya kak, jadi bisa. Saya catat pesanannya sekarang ya kak ✅\n\nSebentar ya, saya proses dulu.",
      ),
    ).toBe(true);
  });

  it("catches the past-tense claim that the dates are already in", () => {
    expect(
      promisesSchedule("Pesanan Kakak sudah saya catat untuk besok ya kak."),
    ).toBe(true);
  });

  // The recovery costs a model call and a possible booking, so a reply that
  // names no date must not reach it, however firmly it promises.
  it("ignores a promise with no date anywhere in it", () => {
    expect(
      promisesSchedule("Baik kak, pesanannya saya proses sekarang ya."),
    ).toBe(false);
  });

  it("ignores a date with no promise behind it", () => {
    expect(
      promisesSchedule("Menu untuk Selasa 1 September adalah ayam teriyaki."),
    ).toBe(false);
  });
});
