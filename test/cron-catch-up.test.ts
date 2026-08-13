import { jakartaDay, lastDueAt } from "@/lib/cron/scheduler";

// WIB is UTC+7 and has no DST, so 21:00 WIB is always 14:00 UTC.
const wib = (iso: string) => new Date(iso);

describe("lastDueAt", () => {
  test("returns today's occurrence once it has passed", () => {
    // 2026-08-13 21:30 WIB — the 21:00 job was due half an hour ago.
    const due = lastDueAt("0 21 * * *", wib("2026-08-13T14:30:00Z"));
    expect(due?.toISOString()).toBe("2026-08-13T14:00:00.000Z");
  });

  test("returns yesterday's occurrence when today's has not come round yet", () => {
    // 2026-08-13 08:00 WIB — the next 21:00 is still ahead.
    const due = lastDueAt("0 21 * * *", wib("2026-08-13T01:00:00Z"));
    expect(due?.toISOString()).toBe("2026-08-12T14:00:00.000Z");
  });

  test("picks the nearest of a twice-daily schedule, not the earlier one", () => {
    // 2026-08-13 21:00 WIB, schedule 08:00 and 20:00 — 20:00 is the answer.
    const due = lastDueAt("0 8,20 * * *", wib("2026-08-13T14:00:00Z"));
    expect(due?.toISOString()).toBe("2026-08-13T13:00:00.000Z");
  });

  test("is exclusive of occurrences still in the future", () => {
    // 19:59 WIB: the 20:00 firing has not happened, so 08:00 is the last due.
    const due = lastDueAt("0 8,20 * * *", wib("2026-08-13T12:59:00Z"));
    expect(due?.toISOString()).toBe("2026-08-13T01:00:00.000Z");
  });
});

describe("jakartaDay", () => {
  test("groups a WIB evening with its own date, not the UTC one", () => {
    // 2026-08-13 21:00 WIB is 14:00 UTC the same day.
    expect(jakartaDay(wib("2026-08-13T14:00:00Z"))).toBe("2026-08-13");
  });

  test("rolls over at WIB midnight, not UTC midnight", () => {
    // 23:00 UTC on the 13th is already 06:00 on the 14th in Jakarta. This is
    // the case the same-day catch-up rule turns on: a job due at 21:00 WIB
    // must not be caught up after the WIB date has moved on, because
    // deduct-daily-quota's "tomorrow" would then mean a different day.
    expect(jakartaDay(wib("2026-08-13T23:00:00Z"))).toBe("2026-08-14");
  });

  test("a 21:00 WIB run and an 08:00 WIB run the next morning differ", () => {
    const due = wib("2026-08-13T14:00:00Z"); // 21:00 WIB Thu
    const boot = wib("2026-08-14T01:00:00Z"); // 08:00 WIB Fri
    expect(jakartaDay(due)).not.toBe(jakartaDay(boot));
  });
});
