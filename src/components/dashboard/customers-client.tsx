"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDate, maskPhone } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Customer = Database["public"]["Tables"]["customers"]["Row"];
type CustomerState = Database["public"]["Tables"]["customer_state"]["Row"];
type CustomerFlags = Database["public"]["Tables"]["customer_flags"]["Row"];

const PAGE_SIZE = 200;
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
  const [editingCell, setEditingCell] = useState<{
    id: string;
    field: "name" | "area" | "sub_area";
    value: string;
  } | null>(null);
  const [editForm, setEditForm] = useState({
    phone_number: "",
    name: "",
    address: "",
    area: "",
    sub_area: "",
    subcontractor_id: "",
    address_type: "",
    delivery_phone: "",
    google_maps_link: "",
    meal_time_preference: "",
    ad_creative: "",
    promo_used: "",
    converted_to_subscription: false,
    notes: "",
    address_2: "",
    area_2: "",
    sub_area_2: "",
    google_maps_link_2: "",
  });
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
      phone_number: string;
      name: string;
      address: string;
      area: string;
      sub_area: string;
      subcontractor_id: string;
      address_type: string;
      delivery_phone: string;
      google_maps_link: string;
      meal_time_preference: string;
      ad_creative: string;
      promo_used: string;
      converted_to_subscription: boolean;
      notes: string;
      address_2: string;
      area_2: string;
      sub_area_2: string;
      google_maps_link_2: string;
    }) => {
      if (!selected) return;
      const { error } = await supabase
        .from("customers")
        .update({
          phone_number: form.phone_number,
          name: form.name,
          address: form.address,
          area: form.area,
          sub_area: form.sub_area || null,
          subcontractor_id: form.subcontractor_id || null,
          address_type: form.address_type || null,
          delivery_phone: form.delivery_phone || null,
          google_maps_link: form.google_maps_link || null,
          meal_time_preference: form.meal_time_preference || null,
          ad_creative: form.ad_creative || null,
          promo_used: form.promo_used || null,
          converted_to_subscription: form.converted_to_subscription,
          notes: form.notes || null,
          address_2: form.address_2 || null,
          area_2: form.area_2 || null,
          sub_area_2: form.sub_area_2 || null,
          google_maps_link_2: form.google_maps_link_2 || null,
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
    const c = customer as Customer & {
      subcontractor_id?: string | null;
      ad_creative?: string | null;
      promo_used?: string | null;
      converted_to_subscription?: boolean | null;
      notes?: string | null;
    };
    setEditForm({
      phone_number: customer.phone_number ?? "",
      name: customer.name ?? "",
      address: customer.address ?? "",
      area: customer.area ?? "",
      sub_area: customer.sub_area ?? "",
      subcontractor_id: c.subcontractor_id ?? "",
      address_type: customer.address_type ?? "",
      delivery_phone: customer.delivery_phone ?? "",
      google_maps_link: customer.google_maps_link ?? "",
      meal_time_preference: customer.meal_time_preference ?? "",
      ad_creative: c.ad_creative ?? "",
      promo_used: c.promo_used ?? "",
      converted_to_subscription: c.converted_to_subscription ?? false,
      notes: c.notes ?? "",
      address_2: (customer as unknown as { address_2?: string | null }).address_2 ?? "",
      area_2: (customer as unknown as { area_2?: string | null }).area_2 ?? "",
      sub_area_2: (customer as unknown as { sub_area_2?: string | null }).sub_area_2 ?? "",
      google_maps_link_2: (customer as unknown as { google_maps_link_2?: string | null }).google_maps_link_2 ?? "",
    });
  }

  async function saveInline(id: string, field: "name" | "area" | "sub_area", value: string) {
    setEditingCell(null);
    const patch =
      field === "name" ? { name: value || null } :
      field === "area" ? { area: value || null } :
      { sub_area: value || null };
    await supabase
      .from("customers")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    void queryClient.invalidateQueries({ queryKey: ["customers"] });
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
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">
                Sub Area
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
                    {(["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const).map((colId) => (
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
                      <td
                        className="px-4 py-3 text-gray-900 cursor-text"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingCell({ id: c.id, field: "name", value: c.name ?? "" });
                        }}
                      >
                        {editingCell?.id === c.id && editingCell.field === "name" ? (
                          <input
                            // biome-ignore lint/a11y/noAutofocus: intentional inline edit activation
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                            onBlur={() => saveInline(c.id, "name", editingCell.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveInline(c.id, "name", editingCell.value);
                              if (e.key === "Escape") setEditingCell(null);
                            }}
                            className="w-full px-1 py-0.5 text-sm border border-orange-400 rounded focus:outline-none"
                          />
                        ) : (
                          <span className="hover:underline decoration-dashed underline-offset-2 decoration-gray-300">
                            {c.name ?? "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {maskPhone(c.phone_number)}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500 cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingCell({ id: c.id, field: "area", value: c.area ?? "" });
                        }}
                      >
                        {editingCell?.id === c.id && editingCell.field === "area" ? (
                          <select
                            // biome-ignore lint/a11y/noAutofocus: intentional inline edit activation
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => saveInline(c.id, "area", e.target.value)}
                            onBlur={() => setEditingCell(null)}
                            className="text-sm border border-orange-400 rounded focus:outline-none px-1 py-0.5"
                          >
                            <option value="">—</option>
                            {DELIVERY_AREAS.map((a) => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="hover:underline decoration-dashed underline-offset-2 decoration-gray-300">
                            {c.area ?? "—"}
                          </span>
                        )}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500 cursor-text"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingCell({ id: c.id, field: "sub_area", value: c.sub_area ?? "" });
                        }}
                      >
                        {editingCell?.id === c.id && editingCell.field === "sub_area" ? (
                          <input
                            // biome-ignore lint/a11y/noAutofocus: intentional inline edit activation
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                            onBlur={() => saveInline(c.id, "sub_area", editingCell.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveInline(c.id, "sub_area", editingCell.value);
                              if (e.key === "Escape") setEditingCell(null);
                            }}
                            className="w-full px-1 py-0.5 text-sm border border-orange-400 rounded focus:outline-none"
                          />
                        ) : (
                          <span className="hover:underline decoration-dashed underline-offset-2 decoration-gray-300">
                            {c.sub_area ?? "—"}
                          </span>
                        )}
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
                <label
                  htmlFor="customer-phone"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Phone
                </label>
                <input
                  id="customer-phone"
                  value={editForm.phone_number}
                  onChange={(e) =>
                    setEditForm({ ...editForm, phone_number: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
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
                  htmlFor="customer-sub-area"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Sub Area
                </label>
                <input
                  id="customer-sub-area"
                  value={editForm.sub_area}
                  onChange={(e) =>
                    setEditForm({ ...editForm, sub_area: e.target.value })
                  }
                  placeholder="e.g. Binus, Pacific Garden"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
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

              <div>
                <label
                  htmlFor="customer-address-type"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Address Type
                </label>
                <input
                  id="customer-address-type"
                  value={editForm.address_type}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address_type: e.target.value })
                  }
                  placeholder="e.g. Rumah, Apartment, Kantor"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label
                  htmlFor="customer-delivery-phone"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Delivery Phone
                </label>
                <input
                  id="customer-delivery-phone"
                  value={editForm.delivery_phone}
                  onChange={(e) =>
                    setEditForm({ ...editForm, delivery_phone: e.target.value })
                  }
                  placeholder="Alternative phone for delivery"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label
                  htmlFor="customer-maps-link"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Google Maps Link
                </label>
                <input
                  id="customer-maps-link"
                  value={editForm.google_maps_link}
                  onChange={(e) =>
                    setEditForm({ ...editForm, google_maps_link: e.target.value })
                  }
                  placeholder="https://maps.app.goo.gl/..."
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div className="pt-1 pb-0.5">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Address 2</p>
              </div>

              <div>
                <label htmlFor="customer-address-2" className="text-xs text-gray-500 block mb-1">
                  Address 2
                </label>
                <textarea
                  id="customer-address-2"
                  value={editForm.address_2}
                  onChange={(e) => setEditForm({ ...editForm, address_2: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label htmlFor="customer-area-2" className="text-xs text-gray-500 block mb-1">
                  Area 2
                </label>
                <select
                  id="customer-area-2"
                  value={editForm.area_2}
                  onChange={(e) => setEditForm({ ...editForm, area_2: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Not set —</option>
                  {DELIVERY_AREAS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="customer-sub-area-2" className="text-xs text-gray-500 block mb-1">
                  Sub Area 2
                </label>
                <input
                  id="customer-sub-area-2"
                  value={editForm.sub_area_2}
                  onChange={(e) => setEditForm({ ...editForm, sub_area_2: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label htmlFor="customer-maps-link-2" className="text-xs text-gray-500 block mb-1">
                  Google Maps Link 2
                </label>
                <input
                  id="customer-maps-link-2"
                  value={editForm.google_maps_link_2}
                  onChange={(e) => setEditForm({ ...editForm, google_maps_link_2: e.target.value })}
                  placeholder="https://maps.app.goo.gl/..."
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label
                  htmlFor="customer-meal-time"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Meal Time Preference
                </label>
                <select
                  id="customer-meal-time"
                  value={editForm.meal_time_preference}
                  onChange={(e) =>
                    setEditForm({ ...editForm, meal_time_preference: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Not set —</option>
                  <option value="lunch_only">Lunch only</option>
                  <option value="dinner_only">Dinner only</option>
                  <option value="both_fixed">Both (fixed)</option>
                  <option value="per_day_decision">Per-day decision</option>
                  <option value="default_lunch">Default lunch</option>
                  <option value="default_dinner">Default dinner</option>
                  <option value="custom_schedule">Custom schedule</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">Ad Creative</label>
                <input
                  value={editForm.ad_creative}
                  onChange={(e) => setEditForm({ ...editForm, ad_creative: e.target.value })}
                  placeholder="e.g. C4"
                  className="w-full px-3 py-2 text-sm text-gray-900 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">Promo Used</label>
                <input
                  value={editForm.promo_used}
                  onChange={(e) => setEditForm({ ...editForm, promo_used: e.target.value })}
                  placeholder="e.g. Rp17k porsi pertama"
                  className="w-full px-3 py-2 text-sm text-gray-900 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="converted-to-subscription"
                  type="checkbox"
                  checked={editForm.converted_to_subscription}
                  onChange={(e) =>
                    setEditForm({ ...editForm, converted_to_subscription: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300 accent-orange-500"
                />
                <label htmlFor="converted-to-subscription" className="text-sm text-gray-700">
                  Converted to subscription
                </label>
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">Notes</label>
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 text-sm text-gray-900 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
                />
              </div>

              {(selected as Customer & { converted_at?: string | null })?.converted_at && (
                <p className="text-xs text-gray-400">
                  Converted:{" "}
                  {new Date(
                    (selected as Customer & { converted_at?: string }).converted_at as string,
                  ).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}
                </p>
              )}

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
