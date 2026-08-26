"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";

type AuditRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  changed_by: string;
  changes: unknown;
  created_at: string | null;
};

type AuditPage = { data: AuditRow[]; total: number; pageSize: number };

async function fetchAudit(
  page: number,
  entityType: string,
  actor: string,
): Promise<AuditPage> {
  const params = new URLSearchParams({ page: String(page) });
  if (entityType.trim()) params.set("entity_type", entityType.trim());
  if (actor.trim()) params.set("actor", actor.trim());
  const res = await fetch(`/api/audit?${params}`);
  const json = await res.json();
  return {
    data: json.data ?? [],
    total: json.total ?? 0,
    pageSize: json.pageSize ?? 50,
  };
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ActivityClient() {
  const [page, setPage] = useState(0);
  const [entityType, setEntityType] = useState("");
  const [actor, setActor] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["audit", page, entityType, actor],
    queryFn: () => fetchAudit(page, entityType, actor),
    // Without this the table blanks out on every page step, which reads as a
    // failed load rather than a slow one.
    placeholderData: keepPreviousData,
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  function onFilter(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setPage(0);
    };
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Activity</h1>
      <p className="text-sm text-gray-500 mb-5">
        Every recorded admin action, newest first. Automatic writes appear as{" "}
        <code className="text-xs">system:…</code>.
      </p>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <Input
          placeholder="Filter by type (orders, customers, settings…)"
          value={entityType}
          onChange={(e) => onFilter(setEntityType)(e.target.value)}
          className="sm:max-w-xs"
        />
        <Input
          placeholder="Filter by admin email"
          value={actor}
          onChange={(e) => onFilter(setActor)(e.target.value)}
          className="sm:max-w-xs"
        />
      </div>

      {isLoading && !data ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing recorded for this filter.
        </p>
      ) : (
        <div className="bg-white border border-gray-100 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium">On</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-50 last:border-0 align-top cursor-pointer hover:bg-gray-50"
                  onClick={() =>
                    setExpanded(expanded === row.id ? null : row.id)
                  }
                >
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                    {formatWhen(row.created_at)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.changed_by || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{row.action}</span>{" "}
                    <span className="text-gray-500">{row.entity_type}</span>
                    {expanded === row.id && (
                      <pre className="mt-2 text-xs bg-gray-50 rounded p-2 overflow-x-auto">
                        {JSON.stringify(row.changes, null, 2)}
                      </pre>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500 break-all">
                    {row.entity_id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3 mt-4 text-sm">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-gray-500">
          {total === 0
            ? "0"
            : `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)}`}{" "}
          of {total}
        </span>
        <button
          type="button"
          disabled={page >= lastPage}
          onClick={() => setPage((p) => p + 1)}
          className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
