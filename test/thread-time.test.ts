import { formatThreadTime } from "@/lib/utils/format";

// The clock is local, so pin it. Every assertion below is a statement about
// how far apart two calendar days are, and that answer changes with the
// machine's timezone if "now" is left to drift.
const NOW = new Date(2026, 7, 29, 13, 46);

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("formatThreadTime", () => {
  it("shows the clock for a message from today", () => {
    expect(formatThreadTime(new Date(2026, 7, 29, 6, 15))).toBe("06.15");
  });

  // Calendar days apart, not 24-hour blocks. A message sent at 23:50 last
  // night is "Kemarin" when read at 00:10 this morning — twenty minutes old,
  // and still yesterday. Subtracting timestamps instead would call it today.
  it("calls last night's message Kemarin, minutes after midnight", () => {
    jest.setSystemTime(new Date(2026, 7, 29, 0, 10));
    expect(formatThreadTime(new Date(2026, 7, 28, 23, 50))).toBe("Kemarin");
  });

  it("falls back to day and month past yesterday", () => {
    expect(formatThreadTime(new Date(2026, 7, 27, 9, 0))).toBe("27 Agu");
  });

  // The year is deliberately dropped: an inbox row is scanned for recency, and
  // anything old enough for the year to matter already reads as old.
  it("drops the year even on a message from last year", () => {
    expect(formatThreadTime(new Date(2025, 11, 24, 9, 0))).toBe("24 Des");
  });
});
