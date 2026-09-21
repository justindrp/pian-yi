import { type NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/cache/settings";
import { jakartaDateString } from "@/lib/menu/week";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { isOutsideWindowError, sendTextMessage } from "@/lib/whatsapp/client";

/**
 * The morning nudge for dated tasks: what is due today, and what is already
 * past its date and still open.
 *
 * Sent on WhatsApp to the numbers in `settings.task_reminder_phones`, which are
 * our own handsets and NOT customers. That is why this calls `sendTextMessage`
 * directly rather than `sendHumanMessage`: the latter requires a `customers`
 * row and writes a `conversations` thread, and an admin is not a customer —
 * giving one a customer record is how Justin got welcomed as a new customer
 * named Clara on 2026-09-14. Nothing is logged to `conversations` here.
 *
 * The reply guards (`sanitizeReply`, `looksEnglish`, `validateReply`) are
 * deliberately not run: they exist to police what the model says to a customer,
 * and no model is involved here — this text is assembled from table rows.
 *
 * Expect this to fail most days. A reminder is business-initiated by
 * definition, and the WABA currently fails every out-of-window send on error
 * 131042 (CLAUDE.md, "The 24-hour window is told to the customer"). The window
 * only opens if that handset messaged the business number in the last 24h. So
 * the push notification below is not a nicety — it is the path that actually
 * delivers on most mornings.
 */

type DueTask = {
  id: string;
  title: string;
  status: string;
  priority: number;
  assignee: string | null;
  due_date: string;
};

function reminderPhones(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function compose(today: string, tasks: DueTask[]): string {
  const dueToday = tasks.filter((t) => t.due_date === today);
  const overdue = tasks.filter((t) => t.due_date < today);

  const lines: string[] = [];
  if (dueToday.length) {
    lines.push(`Jatuh tempo hari ini (${dueToday.length}):`);
    for (const t of dueToday) {
      lines.push(`• ${t.priority === 1 ? "[!] " : ""}${t.title}`);
    }
  }
  if (overdue.length) {
    if (lines.length) lines.push("");
    lines.push(`Lewat tenggat (${overdue.length}):`);
    for (const t of overdue) {
      lines.push(`• ${t.title} — due ${t.due_date}`);
    }
  }
  lines.push("");
  lines.push("Buka /tasks untuk detail.");
  return lines.join("\n");
}

export async function POST(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const today = jakartaDateString();
  const db = createAdminClient();

  // Walked rather than capped: a silently truncated reminder is a reminder
  // that drops exactly the tasks nobody is thinking about (CLAUDE.md #9).
  const { rows, error } = await fetchAllRows<DueTask>((from, to) =>
    db
      .from("tasks")
      .select("id, title, status, priority, assignee, due_date")
      .not("due_date", "is", null)
      .lte("due_date", today)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .order("priority", { ascending: true })
      .range(from, to),
  );

  if (error) {
    console.error("[task-reminders] read failed", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  if (rows.length === 0) {
    console.log("[task-reminders] nothing due");
    return NextResponse.json({ ok: true, data: { due: 0, sent: 0 } });
  }

  const text = compose(today, rows);
  const phones = reminderPhones(await getSetting("task_reminder_phones"));
  if (phones.length === 0) {
    console.log(
      "[task-reminders] settings.task_reminder_phones is empty; push only",
    );
  }

  let sent = 0;
  let whatsappFailed = false;
  for (const phone of phones) {
    try {
      await sendTextMessage(phone, text);
      sent++;
    } catch (err) {
      whatsappFailed = true;
      // Named rather than swallowed: the whole point of this job is that
      // somebody finds out, and a reminder that fails quietly is the bug it
      // was written to prevent.
      console.error(
        `[task-reminders] WhatsApp send failed${
          isOutsideWindowError(err) ? " (24h window shut)" : ""
        }:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Push always goes out when WhatsApp did not land anywhere, so the reminder
  // still arrives on the days the window is shut — which is most of them.
  if (sent === 0 || whatsappFailed) {
    const dueToday = rows.filter((t) => t.due_date === today).length;
    const overdue = rows.length - dueToday;
    await sendPushToAllAdmins(
      `Tasks — ${dueToday} due today${overdue ? `, ${overdue} overdue` : ""}`,
      rows
        .slice(0, 3)
        .map((t) => t.title)
        .join(" | "),
      "/tasks",
      "high",
    );
  }

  return NextResponse.json({
    ok: true,
    data: { due: rows.length, sent, phones: phones.length },
  });
}

export const dynamic = "force-dynamic";
