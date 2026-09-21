import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { buildCalendar, type IcsTask } from "@/lib/tasks/ics";

/**
 * The task queue as a calendar Outlook can subscribe to.
 *
 * Outlook cannot sign in to this app — a subscribed calendar is fetched by
 * Microsoft's servers with no cookie and no chance to prompt anyone — so the
 * URL carries its own secret instead. That makes the URL a credential for the
 * whole task list: anyone holding it reads every title, body and assignee. It
 * is deliberately NOT in `settings`, which is editable and visible in the
 * dashboard UI; it sits in the env next to CRON_SECRET, which is the same kind
 * of thing and is already handled that way.
 *
 * Read-only on purpose. Outlook re-fetches a subscribed calendar on its own
 * schedule and will not say when — often hours, occasionally a day. This feed
 * is for seeing deadlines next to meetings, never for being reminded on time;
 * that is what `/api/cron/task-reminders` is for.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const secret = process.env.TASKS_ICS_TOKEN;
  if (!secret) {
    console.error("[tasks/calendar.ics] TASKS_ICS_TOKEN is not set");
    return NextResponse.json(
      { ok: false, error: "Calendar feed is not configured" },
      { status: 503 },
    );
  }

  // Outlook sends nothing it was not given, so the token is a query parameter.
  const token = req.nextUrl.searchParams.get("token");
  if (token !== secret) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  // Walked rather than a bare select: PostgREST caps a response at 1000 rows
  // and says nothing when it truncates (CLAUDE.md, principle 9). A calendar
  // that quietly loses its last deadlines is worse than no calendar.
  const { rows, error } = await fetchAllRows<IcsTask>((from, to) =>
    db
      .from("tasks")
      .select(
        "id, title, body, status, priority, area, assignee, blocked_on, due_date",
      )
      .not("due_date", "is", null)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .range(from, to),
  );

  if (error) {
    console.error("[tasks/calendar.ics] read failed", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  return new Response(buildCalendar(rows, { host: req.nextUrl.host }), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="pian-yi-tasks.ics"',
      // The feed is a credential in a URL; keep it out of shared caches.
      "Cache-Control": "private, no-store",
    },
  });
}

export const dynamic = "force-dynamic";
