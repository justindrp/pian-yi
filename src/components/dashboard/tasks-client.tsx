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

async function fetchTasks(): Promise<Task[]> {
  const res = await fetch("/api/tasks");
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "Failed to load tasks");
  return json.data ?? [];
}

export default function TasksClient() {
  const qc = useQueryClient();
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks,
  });

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
                <th className="px-3 py-2 font-medium w-20">Priority</th>
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
                      {PRIORITY_LABEL[t.priority] ?? t.priority}
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
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[t.status] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      {STATUS_LABEL[t.status] ?? t.status}
                    </span>
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
