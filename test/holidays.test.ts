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

  it("still lists the Minggu through a stretch with no libur nasional", () => {
    // Quiet stretch: nothing between Maulid and Natal. The section used to be
    // omitted entirely here, which left the model with no closed dates at all
    // for six weeks and the day-of-week arithmetic to do itself.
    const block = describeUpcomingHolidays("2026-09-01", 45) as string;
    expect(block).toContain("Minggu 6 September 2026: TUTUP, hari Minggu");
    expect(block).toContain("Minggu 27 September 2026: TUTUP, hari Minggu");
  });

  it("names every Minggu in the range the customer asked about", () => {
    // Julie, 2026-08-29: asked for 1-7 September and was quoted seven delivery
    // days at 28 porsi. 6 September is a Minggu, so the run is six days and 24
    // porsi. The date has to be on the list the model reads, not derived.
    const block = describeUpcomingHolidays("2026-08-29", 20) as string;
    const sundays = block
      .split("\n")
      .filter((l) => l.includes("hari Minggu"))
      .length;
    expect(block).toContain("Minggu 6 September 2026: TUTUP, hari Minggu");
    expect(sundays).toBe(3);
    // 1-5 and 7 September are working days, so none of them may be listed.
    const septClosed = block
      .split("\n")
      .map((l) => /(\d+) September 2026/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    expect(septClosed.filter((d) => d <= 7)).toEqual([6]);
  });

  it("names a Minggu that is also a libur nasional only once", () => {
    // Two lines for one date would let the model subtract it twice.
    const block = describeUpcomingHolidays("2026-03-20", 4) as string;
    const lines = block.split("\n").filter((l) => l.includes("22 Maret 2026"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Idulfitri");
  });

  it("keeps the list in date order once the Minggu are merged in", () => {
    const block = describeUpcomingHolidays("2026-08-14", 10) as string;
    const dates = block
      .split("\n")
      .map((l) => /(\d+) (Agustus|September)/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it("returns null past the end of the list rather than implying no holidays", () => {
    // 2027's SKB is not published until ~September 2026. An empty list must not
    // read as "clear all year" — the prompt tells the bot to escalate instead.
    expect(describeUpcomingHolidays("2027-03-01", 45)).toBeNull();
  });
});
