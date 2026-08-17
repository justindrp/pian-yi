import {
  describeUpcomingHolidays,
  formatHolidayDate,
  HOLIDAYS,
  upcomingHolidays,
} from "@/lib/holidays/id";

describe("HOLIDAYS", () => {
  it("matches the 2026 SKB: 17 libur nasional, 8 cuti bersama", () => {
    expect(HOLIDAYS.filter((h) => h.type === "libur_nasional")).toHaveLength(
      17,
    );
    expect(HOLIDAYS.filter((h) => h.type === "cuti_bersama")).toHaveLength(8);
  });

  it("is sorted, so the prompt lists closures in the order they arrive", () => {
    const dates = HOLIDAYS.map((h) => h.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("upcomingHolidays", () => {
  it("includes today itself", () => {
    // The 2026-08-16 case: asked on the 16th about "besok", 17 Agustus must be
    // in the window. Asked on the 17th, today is the closure being asked about.
    expect(upcomingHolidays("2026-08-17", 45).map((h) => h.date)).toContain(
      "2026-08-17",
    );
  });

  it("excludes holidays already past", () => {
    expect(upcomingHolidays("2026-08-18", 45).map((h) => h.date)).not.toContain(
      "2026-08-17",
    );
  });

  it("stops at the end of the window", () => {
    // Maulid is 8 days out, Natal is not.
    const dates = upcomingHolidays("2026-08-17", 45).map((h) => h.date);
    expect(dates).toEqual(["2026-08-17", "2026-08-25"]);
  });

  it("returns the whole Idulfitri run, holidays and cuti bersama together", () => {
    expect(upcomingHolidays("2026-03-18", 10).map((h) => h.date)).toEqual([
      "2026-03-18",
      "2026-03-19",
      "2026-03-20",
      "2026-03-21",
      "2026-03-22",
      "2026-03-23",
      "2026-03-24",
    ]);
  });
});

describe("formatHolidayDate", () => {
  it("names the day in Indonesian", () => {
    expect(formatHolidayDate("2026-08-17")).toBe("Senin 17 Agustus 2026");
    expect(formatHolidayDate("2026-12-25")).toBe("Jumat 25 Desember 2026");
  });
});

describe("describeUpcomingHolidays", () => {
  it("marks a libur nasional as closed", () => {
    const block = describeUpcomingHolidays("2026-08-17", 3);
    expect(block).toContain(
      "Senin 17 Agustus 2026 — Proklamasi Kemerdekaan RI",
    );
    expect(block).toContain("TUTUP");
  });

  it("marks a cuti bersama as needing a check, not a closure", () => {
    const block = describeUpcomingHolidays("2026-05-15", 1) as string;
    expect(block).toContain("cuti bersama");
    expect(block).not.toContain("TUTUP");
    expect(block).toContain("tergantung dapur partner");
  });

  it("returns null when nothing is coming up, so the section is omitted", () => {
    // Quiet stretch: nothing between Maulid and Natal.
    expect(describeUpcomingHolidays("2026-09-01", 45)).toBeNull();
  });

  it("returns null past the end of the list rather than implying no holidays", () => {
    // 2027's SKB is not published until ~September 2026. An empty list must not
    // read as "clear all year" — the prompt tells the bot to escalate instead.
    expect(describeUpcomingHolidays("2027-03-01", 45)).toBeNull();
  });
});
