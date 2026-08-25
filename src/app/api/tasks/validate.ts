import { NextResponse } from "next/server";

/**
 * `tasks.status` is text, not an enum, so nothing at the database level stops
 * an unknown value from landing. A task with `status: "vibes"` is worse than a
 * rejected write: it disappears from every filter chip on /tasks and only ever
 * shows up under "All". The allowlist lives here, and both routes use it.
 */
export const STATUSES = ["open", "in_progress", "blocked", "done"] as const;

/** Open work first, done last. Alphabetical order on the column puts `done` second. */
export const STATUS_RANK: Record<string, number> = {
  blocked: 0,
  in_progress: 1,
  open: 2,
  done: 3,
};

const MAX_TITLE = 300;

export function badRequest(error: string): Response {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

/** Trim a string field to null; leave anything else alone for the caller to reject. */
export function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

/**
 * Returns the reason the input is unusable, or null if it is fine. Only the
 * fields present are checked, so it serves POST and PATCH alike.
 */
export function validateTaskInput(
  input: Record<string, unknown>,
  { titleRequired }: { titleRequired: boolean },
): string | null {
  const has = (k: string) => k in input && input[k] !== undefined;

  if (titleRequired || has("title")) {
    // A cleared title field would otherwise reach Postgres as null and come
    // back as a 500 on a not-null constraint.
    const title = text(input.title);
    if (!title) return "A task needs a title";
    if (title.length > MAX_TITLE)
      return `Title is longer than ${MAX_TITLE} characters`;
  }

  if (has("status")) {
    const status = text(input.status);
    if (!status || !STATUSES.includes(status as (typeof STATUSES)[number]))
      return `Status must be one of ${STATUSES.join(", ")}`;
  }

  if (has("priority")) {
    const p = input.priority;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 3)
      return "Priority must be 1, 2 or 3";
  }

  for (const key of ["customer_id", "order_id"]) {
    if (!has(key)) continue;
    const value = input[key];
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !isUuid(value))
      return `${key} must be a customer or order id`;
  }

  if (has("due_date")) {
    const due = text(input.due_date);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due))
      return "Due date must be YYYY-MM-DD";
  }

  for (const key of ["body", "area", "assignee", "blocked_on"]) {
    if (has(key) && input[key] !== null && typeof input[key] !== "string")
      return `${key} must be text`;
  }

  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
