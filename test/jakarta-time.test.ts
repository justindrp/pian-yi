import { jakartaDateString } from "@/lib/menu/week";
import {
  addDays,
  earliestDeliveryDate,
  isDeliveryDay,
  jakartaHour,
  jakartaTimeString,
} from "@/lib/time/jakarta";

const at = (iso: string) => new Date(iso);

describe("jakarta wall clock", () => {
  test("reads WIB, not the UTC the server runs on", () => {
    expect(jakartaTimeString(at("2026-08-20T12:05:00Z"))).toBe("19:05");
    expect(jakartaHour(at("2026-08-20T12:05:00Z"))).toBe(19);
  });

  // Railway runs UTC, so a prompt built between 00:00 and 07:00 WIB used to
  // assert yesterday's date.
  test("date rolls over at WIB midnight, not UTC midnight", () => {
    expect(jakartaDateString(at("2026-08-20T19:00:00Z"))).toBe("2026-08-21");
    expect(jakartaTimeString(at("2026-08-20T19:00:00Z"))).toBe("02:00");
  });
});

describe("isDeliveryDay", () => {
  test("Minggu is closed", () => {
    expect(isDeliveryDay("2026-08-23")).toBe(false);
  });

  test("a libur nasional is closed", () => {
    expect(isDeliveryDay("2026-08-17")).toBe(false);
  });

  // Closure is a property of the kitchen, not of the calendar. Maulid Nabi is
  // in OPEN_DESPITE_HOLIDAY because Thenie works it, and this test asserted the
  // opposite for a day after that entry landed — the exception had no coverage
  // of its own, so the only thing that noticed was a stale red test.
  test("a tanggal merah in OPEN_DESPITE_HOLIDAY is open", () => {
    expect(isDeliveryDay("2026-08-25")).toBe(true);
  });

  test("an ordinary Sabtu is open", () => {
    expect(isDeliveryDay("2026-08-22")).toBe(true);
  });
});

describe("earliestDeliveryDate", () => {
  test("tomorrow, while the cutoff is still ahead", () => {
    expect(
      earliestDeliveryDate({
        deadlineHour: 16,
        now: at("2026-08-20T08:00:00Z"),
      }),
    ).toEqual({
      date: "2026-08-21",
      deadlinePassed: false,
    });
  });

  test("the cutoff hour itself has already passed", () => {
    expect(
      earliestDeliveryDate({
        deadlineHour: 16,
        now: at("2026-08-20T09:00:00Z"),
      }),
    ).toEqual({
      date: "2026-08-22",
      deadlinePassed: true,
    });
  });

  // 19:05 WIB on 2026-08-20: the bot told +6282178331611 it could start "besok,
  // kan Jumat" three hours after the cutoff, because the prompt gave it the
  // deadline hour and never the time.
  test("the 2026-08-20 incident lands on Sabtu, not Jumat", () => {
    expect(
      earliestDeliveryDate({
        deadlineHour: 16,
        now: at("2026-08-20T12:05:00Z"),
      }),
    ).toEqual({
      date: "2026-08-22",
      deadlinePassed: true,
    });
  });

  test("skips Minggu", () => {
    expect(
      earliestDeliveryDate({
        deadlineHour: 16,
        now: at("2026-08-22T08:00:00Z"),
      }).date,
    ).toBe("2026-08-24");
  });

  test("skips a libur nasional", () => {
    // Minggu 16 → Senin 17 is Kemerdekaan → Selasa 18.
    expect(
      earliestDeliveryDate({
        deadlineHour: 16,
        now: at("2026-08-16T08:00:00Z"),
      }).date,
    ).toBe("2026-08-18");
  });

  test("does not skip a tanggal merah the kitchen works through", () => {
    expect(
      earliestDeliveryDate({
        deadlineHour: 16,
        now: at("2026-08-24T08:00:00Z"),
      }).date,
    ).toBe("2026-08-25");
  });
});

describe("addDays", () => {
  test("crosses a month boundary", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
  });
});
