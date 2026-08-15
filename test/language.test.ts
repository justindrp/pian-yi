import { looksEnglish } from "@/lib/claude/language";

describe("looksEnglish", () => {
  test("catches the reply that actually shipped in English", () => {
    // Simulator run, 2026-08-15, answering "menu hari ini apa ya kak".
    expect(looksEnglish("I'll send the menu image for you to check.")).toBe(true);
  });

  test("passes real Indonesian replies through untouched", () => {
    const replies = [
      "Untuk menu minggu depan (mulai Senin, 17 Agustus 2026), saya kirim gambarnya ya kak.",
      "Maaf kak, menu minggu depan belum terbit ya. Menu baru selalu kami publikasikan setiap hari Jumat.",
      "Baik kak, terima kasih ya 😊",
      "oke kak siap",
    ];
    for (const r of replies) expect(looksEnglish(r)).toBe(false);
  });

  test("an English fragment inside an Indonesian reply is not a language slip", () => {
    // Customers say "next week" and "cancel" constantly; rewriting a good
    // Indonesian reply over one borrowed phrase is worse than letting it be.
    expect(
      looksEnglish("Siap kak, untuk next week saya catat ya pesanannya"),
    ).toBe(false);
    expect(looksEnglish("Baik kak, orderannya saya cancel ya")).toBe(false);
  });

  test("needs two English markers, so a stray word is not enough", () => {
    expect(looksEnglish("Halo")).toBe(false);
    expect(looksEnglish("")).toBe(false);
  });

  test("catches longer English replies too", () => {
    expect(
      looksEnglish(
        "Sorry, the menu for next week is not published yet. It goes live on Friday.",
      ),
    ).toBe(true);
  });
});
