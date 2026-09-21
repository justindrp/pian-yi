import {
  buildCalendar,
  escapeText,
  fold,
  type IcsTask,
  nextDay,
} from "@/lib/tasks/ics";

const task = (over: Partial<IcsTask> = {}): IcsTask => ({
  id: "11111111-1111-1111-1111-111111111111",
  title: "Kontrak dengan bos",
  body: null,
  status: "open",
  priority: 2,
  area: null,
  assignee: null,
  blocked_on: null,
  due_date: "2026-09-21",
  ...over,
});

const lines = (ics: string) => ics.split("\r\n");

describe("escapeText", () => {
  // The bug this test exists for: the escape was written as "\;" in the JS
  // source, which evaluates to a bare ";" — so semicolons went into the feed
  // unescaped and ended the property value early. Outlook shows nothing and
  // reports no error, so nothing would have pointed at it.
  test("escapes the four characters RFC 5545 reserves", () => {
    expect(escapeText("a;b")).toBe(String.raw`a\;b`);
    expect(escapeText("a,b")).toBe(String.raw`a\,b`);
    expect(escapeText("a\\b")).toBe(String.raw`a\\b`);
    expect(escapeText("a\nb")).toBe(String.raw`a\nb`);
  });

  test("escapes the backslash before the others, not after", () => {
    // Escaping ";" first and "\" second would turn a literal `a\;b` into
    // `a\\;b` — an escaped backslash followed by a live semicolon, which ends
    // the property value early.
    expect(escapeText(String.raw`a\;b`)).toBe(String.raw`a\\\;b`);
  });
});

describe("fold", () => {
  test("leaves a line of 75 octets alone", () => {
    const line = "x".repeat(75);
    expect(fold(line)).toBe(line);
  });

  test("folds a longer line with a leading space on the continuation", () => {
    const folded = fold("x".repeat(80));
    expect(folded).toBe(`${"x".repeat(75)}\r\n ${"x".repeat(5)}`);
  });

  test("never splits a multi-byte character down the middle", () => {
    // 40 em-dashes: 3 octets each, 120 total, so it has to fold mid-character
    // unless the octet walk backs up off the continuation bytes.
    const folded = fold("—".repeat(40));
    for (const part of folded.split("\r\n ")) {
      expect(part).not.toContain("�");
    }
    expect(folded.replace(/\r\n /g, "")).toBe("—".repeat(40));
  });
});

describe("nextDay", () => {
  test("DTEND is the day after, because an all-day DTEND is exclusive", () => {
    expect(nextDay("2026-09-21")).toBe("2026-09-22");
  });

  test("rolls over a month and a year end", () => {
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("buildCalendar", () => {
  const opts = {
    host: "pian-yi.example",
    now: new Date("2026-09-21T09:00:00Z"),
  };

  test("wraps the events in one VCALENDAR", () => {
    const out = lines(buildCalendar([task()], opts));
    expect(out[0]).toBe("BEGIN:VCALENDAR");
    expect(out.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(out.filter((l) => l === "END:VEVENT")).toHaveLength(1);
    expect(out[out.length - 2]).toBe("END:VCALENDAR");
  });

  test("every line ends CRLF, as the spec requires", () => {
    const ics = buildCalendar([task()], opts);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.includes("\n\r")).toBe(false);
    for (const line of ics.split("\r\n").slice(0, -1)) {
      expect(line.endsWith("\n")).toBe(false);
    }
  });

  test("an all-day event spans exactly one day", () => {
    const out = lines(buildCalendar([task()], opts));
    expect(out).toContain("DTSTART;VALUE=DATE:20260921");
    expect(out).toContain("DTEND;VALUE=DATE:20260922");
  });

  // The UID is what stops Outlook stacking a fresh copy of every task on each
  // poll. It has to be derived from the task id and nothing time-varying.
  test("the UID is stable across two renders at different times", () => {
    const a = lines(buildCalendar([task()], opts)).find((l) =>
      l.startsWith("UID:"),
    );
    const b = lines(
      buildCalendar([task()], {
        ...opts,
        now: new Date("2026-10-01T00:00:00Z"),
      }),
    ).find((l) => l.startsWith("UID:"));
    expect(a).toBe(b);
    expect(a).toBe(
      "UID:task-11111111-1111-1111-1111-111111111111@pian-yi.example",
    );
  });

  test("blocked tasks are tentative and say so in the title", () => {
    const out = lines(
      buildCalendar([task({ status: "blocked", blocked_on: "Justin" })], opts),
    );
    expect(out).toContain("STATUS:TENTATIVE");
    expect(
      out.some((l) => l.startsWith("SUMMARY:") && l.includes("BLOCKED")),
    ).toBe(true);
    expect(out.some((l) => l.includes("Waiting on: Justin"))).toBe(true);
  });

  test("a priority-1 task is marked in the summary", () => {
    const out = lines(buildCalendar([task({ priority: 1 })], opts));
    expect(out.some((l) => l.startsWith("SUMMARY:!"))).toBe(true);
  });

  test("carries an alarm at 09:00 on the due day", () => {
    const out = lines(buildCalendar([task()], opts));
    expect(out).toContain("BEGIN:VALARM");
    expect(out).toContain("TRIGGER:PT9H");
  });

  test("a body with a newline stays inside its DESCRIPTION property", () => {
    const out = lines(
      buildCalendar(
        [task({ body: "line one\nline two", area: "money" })],
        opts,
      ),
    );
    // Folded continuations begin with a space; no unfolded line may appear
    // that is neither a property nor a continuation.
    const description = out.find((l) => l.startsWith("DESCRIPTION:"));
    expect(description).toBeDefined();
    expect(description).toContain("line one\\nline two");
    expect(out).not.toContain("line two");
  });

  test("an empty queue still produces a valid empty calendar", () => {
    const out = lines(buildCalendar([], opts));
    expect(out[0]).toBe("BEGIN:VCALENDAR");
    expect(out).not.toContain("BEGIN:VEVENT");
    expect(out[out.length - 2]).toBe("END:VCALENDAR");
  });
});
