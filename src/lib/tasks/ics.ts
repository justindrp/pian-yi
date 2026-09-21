/**
 * Rendering the task queue as iCalendar (RFC 5545), for Outlook to subscribe to.
 *
 * Kept out of the route because this is the part with sharp edges — escaping
 * and line folding are where a calendar feed goes wrong, and it goes wrong
 * silently: Outlook does not report a parse error, it just shows nothing, or
 * shows one event where there should be forty. The route stays thin so this can
 * be tested without a database.
 */

export type IcsTask = {
  id: string;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  area: string | null;
  assignee: string | null;
  blocked_on: string | null;
  due_date: string;
};

/** RFC 5545 §3.3.11: backslash, semicolon and comma escape; newlines become \n. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 §3.1: no content line over 75 octets. Continuation lines begin with
 * a single space, which costs one of the 75.
 *
 * Folded on octets rather than characters because a task title is routinely
 * Indonesian and may carry multi-byte characters; splitting one down the middle
 * produces a file Outlook refuses without saying why.
 */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never cut inside a UTF-8 sequence: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80)
      end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

/** `2026-09-21` -> `20260921`, the DATE form an all-day event takes. */
export function icsDate(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/** DTEND on an all-day event is exclusive, so a one-day task ends tomorrow. */
export function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function eventFor(task: IcsTask, stamp: string, host: string): string[] {
  // Priority and status ride in the title because a phone's calendar shows the
  // title and nothing else, and "blocked" is the one thing worth seeing there.
  const marks = [
    task.priority === 1 ? "!" : null,
    task.status === "blocked" ? "BLOCKED" : null,
    task.status === "in_progress" ? "WIP" : null,
  ].filter(Boolean);
  const summary = marks.length
    ? `${marks.join(" ")} — ${task.title}`
    : task.title;

  const description = [
    task.body,
    task.area ? `Area: ${task.area}` : null,
    task.assignee ? `Assignee: ${task.assignee}` : null,
    task.blocked_on ? `Waiting on: ${task.blocked_on}` : null,
    `Status: ${task.status}`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "BEGIN:VEVENT",
    // Stable across refreshes, so Outlook updates the event in place rather
    // than accumulating a duplicate every time it polls.
    fold(`UID:task-${task.id}@${host}`),
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(task.due_date)}`,
    `DTEND;VALUE=DATE:${icsDate(nextDay(task.due_date))}`,
    fold(`SUMMARY:${escapeText(summary)}`),
    fold(`DESCRIPTION:${escapeText(description)}`),
    fold(`URL:https://${host}/tasks`),
    "TRANSP:TRANSPARENT",
    task.status === "blocked" ? "STATUS:TENTATIVE" : "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    // Relative to 00:00 on the due date, so this fires at 09:00 that morning.
    "TRIGGER:PT9H",
    fold(`DESCRIPTION:${escapeText(summary)}`),
    "END:VALARM",
    "END:VEVENT",
  ];
}

/** The whole document, CRLF-terminated as the spec requires. */
export function buildCalendar(
  tasks: IcsTask[],
  opts: { host: string; now?: Date },
): string {
  const stamp = `${(opts.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 15)}Z`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pian Yi Catering//Tasks//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Pian Yi — Tasks",
    "X-WR-TIMEZONE:Asia/Jakarta",
    // Outlook treats these as hints and polls on its own schedule regardless.
    // Sent anyway because some clients do honour them.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...tasks.flatMap((task) => eventFor(task, stamp, opts.host)),
    "END:VCALENDAR",
  ];

  return `${lines.join("\r\n")}\r\n`;
}
