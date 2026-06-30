"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const AREAS = ["Alam Sutera", "Gading Serpong", "Karawaci", "BSD Baru", "BSD Lama"];

type Neighborhood = { id: string; area: string; name: string };

async function fetchNeighborhoods(): Promise<Neighborhood[]> {
  const res = await fetch("/api/settings/neighborhoods");
  const json = await res.json();
  return json.data ?? [];
}

export default function AreasClient() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["neighborhoods"],
    queryFn: fetchNeighborhoods,
  });

  const addMutation = useMutation({
    mutationFn: (vars: { area: string; name: string }) =>
      fetch("/api/settings/neighborhoods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["neighborhoods"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch("/api/settings/neighborhoods", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["neighborhoods"] }),
  });

  const byArea: Record<string, Neighborhood[]> = {};
  for (const area of AREAS) byArea[area] = [];
  for (const n of data ?? []) {
    if (byArea[n.area]) byArea[n.area].push(n);
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Delivery Areas</h1>
      <p className="text-sm text-gray-500">
        Neighborhood names the chatbot uses to identify which area a customer is in.
      </p>

      {isLoading ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : (
        AREAS.map((area) => (
          <AreaPanel
            key={area}
            area={area}
            neighborhoods={byArea[area]}
            onAdd={(name) => addMutation.mutate({ area, name })}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
        ))
      )}
    </div>
  );
}

function AreaPanel({
  area,
  neighborhoods,
  onAdd,
  onDelete,
}: {
  area: string;
  neighborhoods: Neighborhood[];
  onAdd: (name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [input, setInput] = useState("");

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const name = input.trim();
    if (!name) return;
    onAdd(name);
    setInput("");
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-gray-900 text-sm">{area}</h2>
        <span className="text-xs text-gray-400">{neighborhoods.length} neighborhoods</span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3 min-h-[28px]">
        {neighborhoods.length === 0 && (
          <span className="text-xs text-gray-400 italic">No neighborhoods yet</span>
        )}
        {neighborhoods.map((n) => (
          <span
            key={n.id}
            className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-xs rounded-full px-2.5 py-1"
          >
            {n.name}
            <button
              type="button"
              onClick={() => onDelete(n.id)}
              className="text-gray-400 hover:text-red-500 leading-none"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add neighborhood... (press Enter)"
        className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-gray-300"
      />
    </div>
  );
}
