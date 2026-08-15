import {
  defaultMenuWeekStart,
  describeMenuWeek,
  describeMenuWeeks,
  mondayOf,
} from "@/lib/menu/week";

describe("mondayOf", () => {
  test("Monday maps to itself, Sunday back to the Monday that started its week", () => {
    expect(mondayOf("2026-08-17")).toBe("2026-08-17"); // Monday
    expect(mondayOf("2026-08-22")).toBe("2026-08-17"); // Saturday
    expect(mondayOf("2026-08-23")).toBe("2026-08-17"); // Sunday
    expect(mondayOf("2026-08-24")).toBe("2026-08-24"); // next Monday
  });
});

describe("defaultMenuWeekStart", () => {
  test("Monday–Wednesday uploads default to the current week", () => {
    expect(defaultMenuWeekStart("2026-08-17")).toBe("2026-08-17");
    expect(defaultMenuWeekStart("2026-08-19")).toBe("2026-08-17");
  });

  test("Thursday onward defaults to next week", () => {
    // Batch 50 (17–22 Agustus) really did go up on Thursday 2026-08-13, which is
    // why the threshold is Thursday and not the nominal Friday publication day.
    expect(defaultMenuWeekStart("2026-08-13")).toBe("2026-08-17");
    expect(defaultMenuWeekStart("2026-08-14")).toBe("2026-08-17");
    expect(defaultMenuWeekStart("2026-08-15")).toBe("2026-08-17");
  });

  test("Sunday belongs to the week that already started, so its next week is one Monday on", () => {
    expect(defaultMenuWeekStart("2026-08-16")).toBe("2026-08-17");
  });
});

describe("describeMenuWeek", () => {
  test("the Vania case: Saturday, next week's image already uploaded", () => {
    // Asked on 2026-08-15 with Batch 50 (week of 17 Agustus) on file. The old
    // prompt hardcoded "current week" and the bot refused to send it.
    expect(describeMenuWeek("2026-08-17", "2026-08-15")).toEqual({
      relation: "next",
      weekStart: "2026-08-17",
    });
  });

  test("same image once its week arrives reads as current", () => {
    expect(describeMenuWeek("2026-08-17", "2026-08-19")).toEqual({
      relation: "current",
      weekStart: "2026-08-17",
    });
  });

  test("an image whose week has ended is past, not current", () => {
    expect(describeMenuWeek("2026-08-10", "2026-08-19").relation).toBe("past");
  });

  test("no recorded week is unknown, never guessed", () => {
    expect(describeMenuWeek(null, "2026-08-15")).toEqual({
      relation: "unknown",
      weekStart: null,
    });
  });
});

describe("describeMenuWeeks", () => {
  test("kitchens that agree yield that week", () => {
    expect(
      describeMenuWeeks(["2026-08-17", "2026-08-17"], "2026-08-15").relation,
    ).toBe("next");
  });

  test("kitchens that disagree yield unknown, so the bot claims no week", () => {
    expect(
      describeMenuWeeks(["2026-08-17", "2026-08-10"], "2026-08-15").relation,
    ).toBe("unknown");
  });

  test("any missing value makes the whole set unknown", () => {
    expect(
      describeMenuWeeks(["2026-08-17", null], "2026-08-15").relation,
    ).toBe("unknown");
    expect(describeMenuWeeks([], "2026-08-15").relation).toBe("unknown");
  });
});
