"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDate, maskPhone } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Customer = Database["public"]["Tables"]["customers"]["Row"];
type CustomerState = Database["public"]["Tables"]["customer_state"]["Row"];
type CustomerFlags = Database["public"]["Tables"]["customer_flags"]["Row"];

const PAGE_SIZE = 20;
const DELIVERY_AREAS = [
  "BSD Baru",
  "BSD Lama",
  "Gading Serpong",
  "Alam Sutera",
  "Bintaro",
  "Graha Raya",
];

export default function CustomersClient() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<Customer | null>(null);
  const [editForm, setEditForm] = useState({ name: "", address: "", area: "", subcontractor_id: "" });
  const queryClient = useQueryClient();
  const supabase = createClient();

  const { data: subcontractors } = useQuery({
    queryKey: ["subcontractors"],
    queryFn: async () => {
      const res = await fetch("/api/subcontractors");
      const json = await res.json() as { ok: boolean; data: Array<{ id: string; name: string; is_active: boolean }> };
      return (json.data ?? []).filter((s) => s.is_active);
    },
  });

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ["customers", page, debouncedSearch],
    queryFn: async () => {
      let q = supabase
        .from("customers")
        .select("*, customer_state(*), customer_flags(*)", { count: "exact" })
        .order("customer_number", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (debouncedSearch) {
        q = q.or(
          `name.ilike.%${debouncedSearch}%,phone_number.ilike.%${debouncedSearch}%`,
        );
      }

      const { data, count } = await q;
      return {
        customers: (data ?? []) as unknown as (Customer & {
          customer_state: CustomerState | null;
          customer_flags: CustomerFlags | null;
        })[],
        total: count ?? 0,
      };
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (form: {
      name: string;
      address: string;
      area: string;
      subcontractor_id: string;
    }) => {
      if (!selected) return;
      const { error } = await supabase
        .from("customers")
        .update({
          name: form.name,
          address: form.address,
          area: form.area,
          subcontractor_id: form.subcontractor_id || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", selected.id);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      setSelected(null);
    },
  });

  function openDetail(customer: Customer) {
    setSelected(customer);
    setEditForm({
      name: customer.name ?? "",
      address: customer.address ?? "",
      area: customer.area ?? "",
      subcontractor_id: (customer as Customer & { subcontractor_id?: string | null }).subcontractor_id ?? "",
    });
  }

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Customers</h1>
        <span className="text-sm text-gray-400">{data?.total ?? 0} total</span>
      </div>

      <div className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone..."
          className="w-full max-w-xs px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 w-10">
                #
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">
                Name
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">
                Phone
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">
                Area
              </th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">
                Remaining
              </th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">
                Avg Price
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">
                State
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? (["a", "b", "c", "d", "e"] as const).map((rowId) => (
                  <tr key={rowId} className="border-b border-gray-50">
                    {(["a", "b", "c", "d", "e", "f", "g", "h"] as const).map((colId) => (
                      <td key={colId} className="px-4 py-3">
                        <div className="h-4 bg-gray-100 rounded animate-pulse w-24" />
                      </td>
                    ))}
                  </tr>
                ))
              : (data?.customers ?? []).map((c) => {
                  const state = c.customer_state?.state ?? "new";
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: interactive table row
                    <tr
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetail(c)}
                      onKeyDown={(e) =>
                        (e.key === "Enter" || e.key === " ") && openDetail(c)
                      }
                      className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 text-gray-400 text-xs tabular-nums">
                        {c.customer_number ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-900">
                        {c.name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {maskPhone(c.phone_number)}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {c.area ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                        {c.portions_remaining > 0 ? c.portions_remaining : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-500 text-xs">
                        {c.avg_price_per_portion > 0
                          ? `Rp ${c.avg_price_per_portion.toLocaleString("id-ID")}`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <StateBadge state={state} />
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {c.created_at ? formatDate(c.created_at) : "—"}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              Previous
            </button>
            <span className="text-xs text-gray-400">
              Page {page + 1} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/20 cursor-default"
            onClick={() => setSelected(null)}
          />
          <div className="relative w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                Customer Detail
              </h2>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Phone</p>
                <p className="text-sm text-gray-900">{selected.phone_number}</p>
              </div>

              <div>
                <label
                  htmlFor="customer-name"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Name
                </label>
                <input
                  id="customer-name"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label
                  htmlFor="customer-address"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Address
                </label>
                <textarea
                  id="customer-address"
                  value={editForm.address}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address: e.target.value })
                  }
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
                />
              </div>

              <div>
                <label
                  htmlFor="customer-area"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Area
                </label>
                <select
                  id="customer-area"
                  value={editForm.area}
                  onChange={(e) =>
                    setEditForm({ ...editForm, area: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Select area —</option>
                  {DELIVERY_AREAS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="customer-subcontractor"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Assigned Subcontractor
                </label>
                <select
                  id="customer-subcontractor"
                  value={editForm.subcontractor_id}
                  onChange={(e) =>
                    setEditForm({ ...editForm, subcontractor_id: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— None —</option>
                  {(subcontractors ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {saveMutation.isError && (
                <p className="text-sm text-red-600">
                  Failed to save. Please try again.
                </p>
              )}

              <button
                type="button"
                onClick={() => saveMutation.mutate(editForm)}
                disabled={saveMutation.isPending}
                className="w-full py-2 bg-orange-500 text-white text-sm rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
              >
                {saveMutation.isPending ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    new: "bg-gray-100 text-gray-600",
    browsing: "bg-blue-50 text-blue-600",
    ordering: "bg-yellow-50 text-yellow-700",
    awaiting_payment: "bg-orange-50 text-orange-700",
    active_subscription: "bg-green-50 text-green-700",
    lapsed: "bg-red-50 text-red-600",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${colors[state] ?? "bg-gray-100 text-gray-600"}`}
    >
      {state.replace(/_/g, " ")}
    </span>
  );
}
