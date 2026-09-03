"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useDeliveryAreas, withCurrentAreas } from "@/hooks/use-delivery-areas";

type Neighborhood = {
  id: string;
  area: string;
  name: string;
  excluded: boolean;
};
type CoverageRule = {
  neighborhoodId: string;
  area: string;
  name: string;
  canDeliver: boolean;
  surchargePerDelivery: number;
};
type Kitchen = {
  id: string;
  name: string;
  customer_nickname: string | null;
  is_active: boolean;
  delivery_areas: string[] | null;
};

async function fetchNeighborhoods(): Promise<Neighborhood[]> {
  const res = await fetch("/api/settings/neighborhoods");
  const json = await res.json();
  return json.data ?? [];
}

async function fetchCoverage(): Promise<Record<string, CoverageRule[]>> {
  const res = await fetch("/api/subcontractors/coverage");
  const json = await res.json();
  return json.data ?? {};
}

async function fetchKitchens(): Promise<Kitchen[]> {
  const res = await fetch("/api/subcontractors");
  const json = await res.json();
  return (json.data ?? []).filter((k: Kitchen) => k.is_active);
}

export default function AreasClient() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["neighborhoods"],
    queryFn: fetchNeighborhoods,
  });
  const { data: kitchens } = useQuery({
    queryKey: ["subcontractors", "active"],
    queryFn: fetchKitchens,
  });
  const { data: coverage } = useQuery({
    queryKey: ["kitchen-coverage"],
    queryFn: fetchCoverage,
  });

  // Which kitchen's coverage is being edited. Coverage is per kitchen — Thenie
  // carries all of BSD Lama and still refuses Apartemen Akasa — so a rule only
  // means something once a kitchen is named.
  const [kitchenId, setKitchenId] = useState<string | null>(null);
  const selected = (kitchens ?? []).find((k) => k.id === kitchenId) ?? null;
  const rules = kitchenId ? (coverage?.[kitchenId] ?? []) : [];
  const ruleFor = (neighborhoodId: string) =>
    rules.find((r) => r.neighborhoodId === neighborhoodId) ?? null;

  // Every area any kitchen has ever carried, not just the served ones: a
  // neighborhood filed under an area whose last kitchen went inactive still has
  // to be visible and deletable.
  const known = useDeliveryAreas("known");
  const allAreas = withCurrentAreas(known, ...(data ?? []).map((n) => n.area));
  // With a kitchen selected the list narrows to what that kitchen carries —
  // ruling on an area it does not serve at all would say nothing.
  const areas = selected
    ? allAreas.filter((a) => (selected.delivery_areas ?? []).includes(a))
    : allAreas;

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["neighborhoods"] });
      qc.invalidateQueries({ queryKey: ["kitchen-coverage"] });
    },
  });

  const excludeMutation = useMutation({
    mutationFn: (vars: { id: string; excluded: boolean }) =>
      fetch("/api/settings/neighborhoods", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["neighborhoods"] }),
  });

  const ruleMutation = useMutation({
    mutationFn: (vars: {
      neighborhood_id: string;
      can_deliver: boolean;
      surcharge_per_delivery: number;
    }) =>
      fetch("/api/subcontractors/coverage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...vars, subcontractor_id: kitchenId }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kitchen-coverage"] }),
  });

  const byArea: Record<string, Neighborhood[]> = {};
  for (const area of areas) byArea[area] = [];
  for (const n of data ?? []) {
    if (byArea[n.area]) byArea[n.area].push(n);
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Delivery Areas</h1>
      <p className="text-sm text-gray-500">
        Neighborhood names the chatbot uses to identify which area a customer is
        in. Pick a dapur to record which of them it refuses and where it charges
        extra per pengiriman.
      </p>

      <div className="flex flex-wrap gap-1.5">
        <KitchenTab
          label="Semua neighborhood"
          active={kitchenId === null}
          onClick={() => setKitchenId(null)}
        />
        {(kitchens ?? []).map((k) => (
          <KitchenTab
            key={k.id}
            label={k.customer_nickname ?? k.name}
            active={kitchenId === k.id}
            onClick={() => setKitchenId(k.id)}
          />
        ))}
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : (
        areas.map((area) => (
          <AreaPanel
            key={area}
            area={area}
            neighborhoods={byArea[area]}
            rules={selected ? rules : null}
            ruleFor={ruleFor}
            onAdd={(name) => addMutation.mutate({ area, name })}
            onDelete={(id) => deleteMutation.mutate(id)}
            onExclude={(vars) => excludeMutation.mutate(vars)}
            onRule={(vars) => ruleMutation.mutate(vars)}
          />
        ))
      )}

      {selected && areas.length === 0 && (
        <p className="text-sm text-gray-400">
          {selected.customer_nickname ?? selected.name} carries no delivery
          areas yet — add them on the subcontractor first.
        </p>
      )}
    </div>
  );
}

function KitchenTab({
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
      className={`text-xs rounded-full px-3 py-1.5 border ${
        active
          ? "bg-gray-900 text-white border-gray-900"
          : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
      }`}
    >
      {label}
    </button>
  );
}

function AreaPanel({
  area,
  neighborhoods,
  rules,
  ruleFor,
  onAdd,
  onDelete,
  onExclude,
  onRule,
}: {
  area: string;
  neighborhoods: Neighborhood[];
  rules: CoverageRule[] | null;
  ruleFor: (neighborhoodId: string) => CoverageRule | null;
  onAdd: (name: string) => void;
  onDelete: (id: string) => void;
  onExclude: (vars: { id: string; excluded: boolean }) => void;
  onRule: (vars: {
    neighborhood_id: string;
    can_deliver: boolean;
    surcharge_per_delivery: number;
  }) => void;
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
        <span className="text-xs text-gray-400">
          {neighborhoods.length} neighborhoods
        </span>
      </div>

      {neighborhoods.length === 0 && (
        <span className="text-xs text-gray-400 italic block mb-3">
          No neighborhoods yet
        </span>
      )}

      {/* Without a kitchen selected this is the plain name list it has always
          been; with one, each name carries that kitchen's verdict. */}
      {rules === null ? (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {/* An excluded name stays on the list rather than being deleted: the
              bot has to recognise it to refuse it. Deleting it only makes the
              bot round the address to the nearest area and sell there. */}
          {neighborhoods.map((n) => (
            <span
              key={n.id}
              className={`inline-flex items-center gap-1 text-xs rounded-full px-2.5 py-1 ${
                n.excluded
                  ? "bg-red-50 text-red-700 line-through"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {n.name}
              <button
                type="button"
                title={
                  n.excluded
                    ? "Kami antar ke sini lagi"
                    : "Tandai tidak diantar — bot menolak alamat di sini"
                }
                onClick={() => onExclude({ id: n.id, excluded: !n.excluded })}
                className="text-gray-400 hover:text-gray-700 leading-none"
              >
                {n.excluded ? "↺" : "⊘"}
              </button>
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
      ) : (
        <div className="divide-y divide-gray-100 mb-3">
          {neighborhoods.map((n) => (
            <CoverageRow
              key={n.id}
              neighborhood={n}
              rule={ruleFor(n.id)}
              onRule={onRule}
            />
          ))}
        </div>
      )}

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

function CoverageRow({
  neighborhood,
  rule,
  onRule,
}: {
  neighborhood: Neighborhood;
  rule: CoverageRule | null;
  onRule: (vars: {
    neighborhood_id: string;
    can_deliver: boolean;
    surcharge_per_delivery: number;
  }) => void;
}) {
  // No rule means the kitchen serves it at the normal rate — the default for
  // every address nobody has asked about.
  const canDeliver = rule?.canDeliver ?? true;
  const surcharge = rule?.surchargePerDelivery ?? 0;
  const [draft, setDraft] = useState(String(surcharge));

  function save(next: { canDeliver?: boolean; surcharge?: number }) {
    onRule({
      neighborhood_id: neighborhood.id,
      can_deliver: next.canDeliver ?? canDeliver,
      surcharge_per_delivery: next.surcharge ?? surcharge,
    });
  }

  return (
    <div className="flex items-center gap-2 py-2">
      <span
        className={`flex-1 text-sm ${canDeliver ? "text-gray-700" : "text-gray-400 line-through"}`}
      >
        {neighborhood.name}
      </span>

      <button
        type="button"
        onClick={() => save({ canDeliver: !canDeliver })}
        className={`text-xs rounded-full px-2.5 py-1 border ${
          canDeliver
            ? "bg-white text-gray-600 border-gray-200"
            : "bg-red-50 text-red-600 border-red-200"
        }`}
      >
        {canDeliver ? "Bisa" : "Tidak bisa"}
      </button>

      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-400">+Rp</span>
        <input
          type="number"
          min={0}
          step={1000}
          value={draft}
          disabled={!canDeliver}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const next = Number(draft);
            if (!Number.isInteger(next) || next < 0) {
              setDraft(String(surcharge));
              return;
            }
            if (next !== surcharge) save({ surcharge: next });
          }}
          className="w-20 text-sm border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50 disabled:text-gray-300 focus:outline-none focus:ring-1 focus:ring-gray-300"
        />
        <span className="text-xs text-gray-400">/kirim</span>
      </div>
    </div>
  );
}
