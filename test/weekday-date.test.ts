import { fixWeekdayNames } from "@/lib/claude/fix-dates";
import { deliveryCalendar } from "@/lib/time/jakarta";

// 2026-08-31 is a Senin; 1 September is Selasa, 2 September is Rabu.
const TODAY = "2026-08-31";

describe("fixWeekdayNames", () => {
  it("corrects the weekday Cindi was given three times", () => {
    expect(
      fixWeekdayNames(
        "Kak Cindi, untuk besok (Selasa, 2 September) pengiriman siang jam 10.00–12.00 WIB ya",
        TODAY,
      ),
    ).toBe(
      "Kak Cindi, untuk besok (Rabu, 2 September) pengiriman siang jam 10.00–12.00 WIB ya",
    );
  });

  it("corrects a date carrying its own year", () => {
    expect(fixWeekdayNames("Mulai: Selasa, 2 September 2026", TODAY)).toBe(
      "Mulai: Rabu, 2 September 2026",
    );
  });

  it("leaves a correct pairing byte-for-byte alone", () => {
    const text = "Mulai Selasa 1 September 2026 ya kak, jam 10.00–12.00 WIB.";
    expect(fixWeekdayNames(text, TODAY)).toBe(text);
  });

  it("never touches minggu meaning week", () => {
    const text = "Menu minggu ini sudah tak kirim ya kak, minggu depan menyusul.";
    expect(fixWeekdayNames(text, TODAY)).toBe(text);
  });

  it("resolves an omitted year forward across December", () => {
    // 2 Januari 2027 is a Sabtu; said in December, it must not resolve to 2026.
    expect(fixWeekdayNames("Mulai Senin 2 Januari kak", "2026-12-28")).toBe(
      "Mulai Sabtu 2 Januari kak",
    );
  });

  it("leaves a date that does not exist untouched", () => {
    const text = "Mulai Senin 31 September kak";
    expect(fixWeekdayNames(text, TODAY)).toBe(text);
  });

  it("corrects every pairing in one reply", () => {
    expect(
      fixWeekdayNames("Senin 2 September dan Rabu 5 September", TODAY),
    ).toBe("Rabu 2 September dan Sabtu 5 September");
  });
});

describe("deliveryCalendar", () => {
  // 2026-08-31T14:54:00Z is 21.54 WIB — the minute Cindi was promised besok.
  const pastCutoff = new Date("2026-08-31T14:54:00Z");

  it("marks tomorrow locked once the cutoff has passed", () => {
    const lines = deliveryCalendar({ deadlineHour: 16, now: pastCutoff }).split(
      "\n",
    );
    expect(lines[0]).toContain("Senin 31 Agustus 2026 — HARI INI");
    expect(lines[1]).toContain("Selasa 1 September 2026 — SUDAH DIKUNCI");
    expect(lines[1]).toContain('"besok"');
    expect(lines[2]).toContain("Rabu 2 September 2026 — bisa dikirim");
  });

  it("leaves tomorrow open while the cutoff is still ahead", () => {
    const lines = deliveryCalendar({
      deadlineHour: 16,
      now: new Date("2026-08-31T07:00:00Z"), // 14.00 WIB
    }).split("\n");
    expect(lines[1]).toContain("Selasa 1 September 2026 — bisa dikirim");
    expect(lines[1]).toContain('"besok"');
  });

  it("marks Minggu closed, so a weekday run cannot pick it up", () => {
    const calendar = deliveryCalendar({ deadlineHour: 16, now: pastCutoff });
    expect(calendar).toContain(
      "Minggu 6 September 2026 — TUTUP, tidak ada pengiriman",
    );
  });

  it("labels tomorrow as besok even when tomorrow is closed", () => {
    // 2026-09-05 is a Sabtu, so besok is Minggu 6 September.
    const lines = deliveryCalendar({
      deadlineHour: 16,
      now: new Date("2026-09-05T14:00:00Z"),
    }).split("\n");
    expect(lines[1]).toContain("Minggu 6 September 2026 — TUTUP");
    expect(lines[1]).toContain('"besok"');
  });
});
