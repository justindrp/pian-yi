"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type LinkedCustomer = {
  id: string;
  name: string | null;
  phone_number: string | null;
};
type LinkedOrder = {
  id: string;
  package_size: number | null;
  status: string | null;
  total_price: number | null;
};

type Task = {
  id: string;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  area: string | null;
  assignee: string | null;
  customer_id: string | null;
  order_id: string | null;
  blocked_on: string | null;
  due_date: string | null;
  created_at: string;
  // What the stale marker on the "Working on" strip counts from. Every PATCH
  // bumps it, so it reads as "when I last did anything to this".
  updated_at: string;
  done_at: string | null;
  customers: LinkedCustomer | null;
  orders: LinkedOrder | null;
};

const STATUSES = ["open", "in_progress", "blocked", "done"] as const;

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_STYLE: Record<string, string> = {
  open: "bg-blue-50 text-blue-700",
  in_progress: "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
  done: "bg-gray-100 text-gray-500",
};

const PRIORITY_LABEL: Record<number, string> = {
  1: "High",
  2: "Normal",
  3: "Low",
};

// The table says P1/P2/P3, the edit form says High/Normal/Low. The table is
// scanned — the rows are sorted by priority, so the order teaches the scale —
// and P1 is the word the integer column, the API error, `pnpm tasks` and the
// docs all use. The form is where a level is chosen, which is the one moment
// the meaning is worth spelling out.
const PRIORITY_SHORT: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
};

// The column used to be a bare "!" or "·" in a 10px gutter, which said nothing
// about the difference between Normal and Low and could not be scanned down.
const PRIORITY_STYLE: Record<number, string> = {
  1: "bg-red-100 text-red-700",
  2: "bg-gray-100 text-gray-600",
  3: "bg-gray-50 text-gray-400",
};

function rupiah(v: number | null): string {
  return v == null ? "—" : `Rp ${v.toLocaleString("id-ID")}`;
}

type TaskList = { tasks: Task[]; wipLimit: number };

async function fetchTasks(): Promise<TaskList> {
  const res = await fetch("/api/tasks");
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "Failed to load tasks");
  // The limit comes from settings, so it is the server's to state — reading it
  // here keeps the button and the route refusing at the same number.
  return { tasks: json.data ?? [], wipLimit: json.wipLimit ?? 3 };
}

/** Whole days since a timestamp. Used to mark work that stopped moving. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// A task in progress that nobody has touched in a week is usually one that was
// put down and not stopped. Left unmarked it takes up a slot of three forever,
// and the strip goes back to being a list nobody trusts.
const STALE_DAYS = 7;

export default function TasksClient() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks,
  });
  const tasks = data?.tasks ?? [];
  const limit = data?.wipLimit ?? 3;

  const [status, setStatus] = useState<string>("not_done");
  const [area, setArea] = useState<string>("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped after a save so the drawer remounts on the server's copy of the row
  // rather than keeping a draft that has already been written.
  const [savedSeq, setSavedSeq] = useState(0);

  const areas = useMemo(
    () =>
      [...new Set(tasks.map((t) => t.area).filter(Boolean) as string[])].sort(),
    [tasks],
  );

  const inProgress = useMemo(
    () => tasks.filter((t) => t.status === "in_progress"),
    [tasks],
  );
  const atLimit = inProgress.length >= limit;

  const counts = useMemo(() => {
    const c: Record<string, number> = { not_done: 0 };
    for (const t of tasks) {
      c[t.status] = (c[t.status] ?? 0) + 1;
      if (t.status !== "done") c.not_done += 1;
    }
    return c;
  }, [tasks]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (
        status === "not_done"
          ? t.status === "done"
          : status && t.status !== status
      )
        return false;
      if (area && t.area !== area) return false;
      if (q && !`${t.title} ${t.body ?? ""}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [tasks, status, area, search]);

  const selected = tasks.find((t) => t.id === openId) ?? null;

  const save = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Task> }) => {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Save failed");
      return json.data as Task;
    },
    onSuccess: () => {
      setSavedSeq((n) => n + 1);
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // Starting and stopping is one press from the list. It used to mean opening
  // the drawer, changing a dropdown and saving, which is three acts of
  // bookkeeping for a fact that is true for an afternoon — so it was never
  // done, and `in_progress` carried 1 row out of 334.
  const toggleStart = (t: Task) =>
    save.mutate({
      id: t.id,
      patch: { status: t.status === "in_progress" ? "open" : "in_progress" },
    });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Delete failed");
    },
    onSuccess: () => {
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const create = useMutation({
    mutationFn: async (patch: Partial<Task>) => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Create failed");
      return json.data as Task;
    },
    onSuccess: (task) => {
      setCreating(false);
      setOpenId(task.id);
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">Tasks</h1>
        <Button size="sm" onClick={() => setCreating(true)}>
          New task
        </Button>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        The work queue. Every change is recorded in{" "}
        <a href="/activity" className="underline">
          Activity
        </a>
        .
      </p>

      {/* Pinned above the filters and outside the table: this is the answer to
          "what am I on right now", and it is worthless if a filter can hide it
          or it has to be found among 190 rows sorted by priority. */}
      {!isLoading && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="text-xs font-medium text-amber-800">
            Working on ({inProgress.length} of {limit})
          </div>
          {inProgress.length === 0 ? (
            <p className="text-xs text-amber-700 mt-1">
              Nothing started. Press Start on a task to put it here.
            </p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-1">
              {inProgress.map((t) => {
                const age = daysSince(t.updated_at);
                return (
                  <li key={t.id} className="flex items-start gap-2 text-sm">
                    <button
                      type="button"
                      onClick={() => toggleStart(t)}
                      className="shrink-0 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-xs text-amber-800 hover:bg-amber-100"
                    >
                      Stop
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenId(t.id)}
                      className="text-left text-gray-900 hover:underline"
                    >
                      {t.title}
                      {age >= STALE_DAYS && (
                        <span className="ml-2 rounded bg-amber-200 px-1 py-0.5 text-xs text-amber-900">
                          untouched {age}d
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mb-3">
        <FilterChip
          label={`Not done (${counts.not_done ?? 0})`}
          active={status === "not_done"}
          onClick={() => setStatus("not_done")}
        />
        {STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={`${STATUS_LABEL[s]} (${counts[s] ?? 0})`}
            active={status === s}
            onClick={() => setStatus(s)}
          />
        ))}
        <FilterChip
          label="All"
          active={status === ""}
          onClick={() => setStatus("")}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <Input
          placeholder="Search title and detail…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        <select
          value={area}
          onChange={(e) => setArea(e.target.value)}
          className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm sm:max-w-[180px]"
        >
          <option value="">All areas</option>
          {areas.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing matches this filter.</p>
      ) : (
        <div className="bg-white border border-gray-100 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="px-3 py-2 font-medium w-16">Priority</th>
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">
                  Area
                </th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">
                  Owner
                </th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-gray-50 last:border-0 align-top cursor-pointer hover:bg-gray-50"
                  onClick={() => setOpenId(t.id)}
                >
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-xs ${PRIORITY_STYLE[t.priority] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      {PRIORITY_SHORT[t.priority] ?? `P${t.priority}`}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        t.status === "done"
                          ? "text-gray-400 line-through"
                          : "text-gray-900"
                      }
                    >
                      {t.title}
                    </span>
                    {t.customers && (
                      <span className="ml-2 text-xs text-gray-500">
                        · {t.customers.name ?? t.customers.phone_number}
                      </span>
                    )}
                    {t.blocked_on && (
                      <div className="text-xs text-red-600 mt-0.5">
                        Waiting on: {t.blocked_on}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500 hidden sm:table-cell">
                    {t.area ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-500 hidden md:table-cell">
                    {t.assignee ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[t.status] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                      {t.status !== "done" && (
                        <button
                          type="button"
                          // The row opens the drawer; this must not.
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStart(t);
                          }}
                          disabled={atLimit && t.status !== "in_progress"}
                          title={
                            atLimit && t.status !== "in_progress"
                              ? `${limit} tasks are already in progress. Stop one first.`
                              : undefined
                          }
                          className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t.status === "in_progress" ? "Stop" : "Start"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <TaskPanel
          key={`${selected.id}-${savedSeq}`}
          task={selected}
          areas={areas}
          saving={save.isPending || remove.isPending}
          error={
            save.error instanceof Error
              ? save.error.message
              : remove.error instanceof Error
                ? remove.error.message
                : null
          }
          onClose={() => setOpenId(null)}
          onSave={(patch) => save.mutate({ id: selected.id, patch })}
          onDelete={() => remove.mutate(selected.id)}
        />
      )}

      {creating && (
        <NewTaskPanel
          areas={areas}
          saving={create.isPending}
          error={create.error instanceof Error ? create.error.message : null}
          onClose={() => setCreating(false)}
          onCreate={(patch) => create.mutate(patch)}
        />
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs border ${
        active
          ? "bg-gray-900 text-white border-gray-900"
          : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );
}

/** Right-hand drawer. Same shape for editing and creating; fields differ. */
function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
      />
      <div className="relative bg-white w-full sm:max-w-lg h-full overflow-y-auto shadow-xl p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-sm font-medium text-gray-500">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-sm"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded-md bg-red-50 text-red-700 text-sm px-3 py-2 mb-3">
      {message}
    </p>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label htmlFor={id} className="block text-xs text-gray-500 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

const selectClass =
  "h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm";

function TaskPanel({
  task,
  areas,
  saving,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  task: Task;
  areas: string[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: Partial<Task>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Partial<Task>>({});
  const value = <K extends keyof Task>(k: K): Task[K] =>
    (draft[k] ?? task[k]) as Task[K];
  const set = (patch: Partial<Task>) => setDraft({ ...draft, ...patch });
  const dirty = Object.keys(draft).length > 0;

  const titleMissing = !String(value("title") ?? "").trim();

  return (
    <Drawer title="Task" onClose={onClose}>
      {error && <ErrorNote message={error} />}
      <Field id="task-title" label="Title">
        <Input
          id="task-title"
          value={value("title")}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="task-status" label="Status">
          <select
            id="task-status"
            className={selectClass}
            value={value("status")}
            onChange={(e) => set({ status: e.target.value })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="task-priority" label="Priority">
          <select
            id="task-priority"
            className={selectClass}
            value={value("priority")}
            onChange={(e) => set({ priority: Number(e.target.value) })}
          >
            {[1, 2, 3].map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="task-area" label="Area">
          <input
            id="task-area"
            list="task-areas"
            className={selectClass}
            value={value("area") ?? ""}
            onChange={(e) => set({ area: e.target.value })}
          />
          <datalist id="task-areas">
            {areas.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <Field id="task-assignee" label="Owner">
          <Input
            id="task-assignee"
            value={value("assignee") ?? ""}
            placeholder="email"
            onChange={(e) => set({ assignee: e.target.value })}
          />
        </Field>
      </div>

      {value("status") === "blocked" && (
        <Field id="task-blocked-on" label="Waiting on">
          <Input
            id="task-blocked-on"
            value={value("blocked_on") ?? ""}
            onChange={(e) => set({ blocked_on: e.target.value })}
          />
        </Field>
      )}

      <Field id="task-due" label="Due date">
        <Input
          id="task-due"
          type="date"
          value={value("due_date") ?? ""}
          onChange={(e) => set({ due_date: e.target.value })}
        />
      </Field>

      {(task.customers || task.orders) && (
        <div className="rounded-md border border-gray-100 bg-gray-50 p-3 mb-3 text-sm">
          <p className="text-xs text-gray-500 mb-1.5">This task is about</p>
          {task.customers && (
            <a
              href={`/customers?f=phone_number:contains:${encodeURIComponent(
                task.customers.phone_number ?? task.customers.name ?? "",
              )}`}
              className="block underline"
            >
              {task.customers.name ?? task.customers.phone_number}
            </a>
          )}
          {task.orders && (
            <a
              href={`/orders?status=&search=${encodeURIComponent(
                task.customers?.phone_number ?? "",
              )}`}
              className="block underline mt-1"
            >
              {task.orders.package_size ?? "?"} porsi ·{" "}
              {rupiah(task.orders.total_price)} · {task.orders.status}
            </a>
          )}
        </div>
      )}

      <Field id="task-body" label="Detail">
        <Textarea
          id="task-body"
          rows={16}
          className="font-mono text-xs leading-relaxed"
          value={value("body") ?? ""}
          onChange={(e) => set({ body: e.target.value })}
        />
      </Field>

      {titleMissing && (
        <p className="text-xs text-red-600 -mt-1 mb-3">A task needs a title.</p>
      )}

      <div className="flex items-center gap-2 mt-4">
        <Button
          disabled={!dirty || saving || titleMissing}
          onClick={() => onSave(draft)}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {value("status") !== "done" && (
          <Button
            variant="outline"
            disabled={saving || titleMissing}
            onClick={() => onSave({ ...draft, status: "done" })}
          >
            Mark done
          </Button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto text-xs text-red-600 hover:underline"
        >
          Delete
        </button>
      </div>
    </Drawer>
  );
}

function NewTaskPanel({
  areas,
  saving,
  error,
  onClose,
  onCreate,
}: {
  areas: string[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (patch: Partial<Task>) => void;
}) {
  const [draft, setDraft] = useState<Partial<Task>>({
    priority: 2,
    status: "open",
  });
  const set = (patch: Partial<Task>) => setDraft({ ...draft, ...patch });

  return (
    <Drawer title="New task" onClose={onClose}>
      {error && <ErrorNote message={error} />}
      <Field id="new-task-title" label="Title">
        <Input
          id="new-task-title"
          autoFocus
          value={draft.title ?? ""}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="new-task-priority" label="Priority">
          <select
            id="new-task-priority"
            className={selectClass}
            value={draft.priority ?? 2}
            onChange={(e) => set({ priority: Number(e.target.value) })}
          >
            {[1, 2, 3].map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="new-task-area" label="Area">
          <input
            id="new-task-area"
            list="task-areas-new"
            className={selectClass}
            value={draft.area ?? ""}
            onChange={(e) => set({ area: e.target.value })}
          />
          <datalist id="task-areas-new">
            {areas.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field id="new-task-body" label="Detail">
        <Textarea
          id="new-task-body"
          rows={10}
          className="font-mono text-xs leading-relaxed"
          value={draft.body ?? ""}
          onChange={(e) => set({ body: e.target.value })}
        />
      </Field>
      <Button
        className="mt-2"
        disabled={!draft.title?.trim() || saving}
        onClick={() => onCreate(draft)}
      >
        {saving ? "Creating…" : "Create task"}
      </Button>
    </Drawer>
  );
}
