"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDate, maskPhone } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Customer = Database["public"]["Tables"]["customers"]["Row"];
type CustomerState = Database["public"]["Tables"]["customer_state"]["Row"];
type CustomerFlags = Database["public"]["Tables"]["customer_flags"]["Row"];

type LedgerRow = {
  id: string;
  kind: "package" | "draw";
  date: string;
  label: string;
  meal_type: string | null;
  change: number;
  status: string | null;
  scheduled: boolean;
  balance: number;
};
type LedgerData = {
  rows: LedgerRow[];
  totalPackage: number;
  totalDrawn: number;
  balance: number;
};

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
  const [showAdd, setShowAdd] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addForm, setAddForm] = useState({
    name: "",
    phone_number: "",
    area: "",
    sub_area: "",
    address: "",
    address_2: "",
    google_maps_link: "",
    subcontractor_id: "",
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

  const { data: ledger, isLoading: ledgerLoading } = useQuery({
    queryKey: ["customer-ledger", selected?.id],
    enabled: !!selected,
    queryFn: async () => {
      const res = await fetch(`/api/customers/${selected?.id}`);
      const json = (await res.json()) as { ok: boolean; data: LedgerData };
      return json.data;
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

  const createMutation = useMutation({
    mutationFn: async (form: typeof addForm) => {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Gagal membuat pelanggan");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      setShowAdd(false);
      setAddForm({ name: "", phone_number: "", area: "", sub_area: "", address: "", address_2: "", google_maps_link: "", subcontractor_id: "" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/customers/${id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Gagal menghapus");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      setDeleteConfirmOpen(false);
      setSelected(null);
    },
  });

  function submitAdd() {
    setAddError(null);
    if (!addForm.phone_number.trim()) {
      setAddError("Nomor telepon wajib diisi");
      return;
    }
    if (!addForm.address.trim()) {
      setAddError("Alamat wajib diisi");
      return;
    }
    createMutation.mutate(addForm, { onError: (e) => setAddError((e as Error).message) });
  }

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
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{data?.total ?? 0} total</span>
          <Button type="button" onClick={() => { setAddError(null); setShowAdd(true); }} className="bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800">+ Add customer</Button>
        </div>
      </div>

      <div className="mb-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone..."
          className="w-full max-w-xs"
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
                        className="px-4 py-3 text-gray-900"
                      >
                        {editingCell?.id === c.id && editingCell.field === "name" ? (
                          <Input
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => saveInline(c.id, "name", editingCell.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveInline(c.id, "name", editingCell.value);
                              if (e.key === "Escape") setEditingCell(null);
                            }}
                            className="w-full h-auto py-0.5 px-1 text-sm border-orange-400"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingCell({ id: c.id, field: "name", value: c.name ?? "" });
                            }}
                            className="cursor-text hover:underline decoration-dashed underline-offset-2 decoration-gray-300"
                          >
                            {c.name ?? "—"}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {maskPhone(c.phone_number)}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500"
                      >
                        {editingCell?.id === c.id && editingCell.field === "area" ? (
                          <select
                            // biome-ignore lint/a11y/noAutofocus: intentional inline edit activation
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => saveInline(c.id, "area", e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => setEditingCell(null)}
                            className="text-sm border border-orange-400 rounded focus:outline-none px-1 py-0.5"
                          >
                            <option value="">—</option>
                            {DELIVERY_AREAS.map((a) => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingCell({ id: c.id, field: "area", value: c.area ?? "" });
                            }}
                            className="cursor-pointer hover:underline decoration-dashed underline-offset-2 decoration-gray-300"
                          >
                            {c.area ?? "—"}
                          </button>
                        )}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500"
                      >
                        {editingCell?.id === c.id && editingCell.field === "sub_area" ? (
                          <Input
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => saveInline(c.id, "sub_area", editingCell.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveInline(c.id, "sub_area", editingCell.value);
                              if (e.key === "Escape") setEditingCell(null);
                            }}
                            className="w-full h-auto py-0.5 px-1 text-sm border-orange-400"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingCell({ id: c.id, field: "sub_area", value: c.sub_area ?? "" });
                            }}
                            className="cursor-text hover:underline decoration-dashed underline-offset-2 decoration-gray-300"
                          >
                            {c.sub_area ?? "—"}
                          </button>
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              Previous
            </Button>
            <span className="text-xs text-gray-400">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {/* Add customer modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Pelanggan Baru</h2>
              <Button type="button" variant="ghost" onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none h-auto w-auto p-0">&times;</Button>
            </div>

            <div>
              <Label htmlFor="add-phone" className="text-xs text-gray-500 block mb-1">Phone *</Label>
              <Input id="add-phone" value={addForm.phone_number} onChange={(e) => setAddForm({ ...addForm, phone_number: e.target.value })} placeholder="+628..." />
            </div>
            <div>
              <Label htmlFor="add-name" className="text-xs text-gray-500 block mb-1">Name</Label>
              <Input id="add-name" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="add-address" className="text-xs text-gray-500 block mb-1">Address *</Label>
              <Textarea id="add-address" value={addForm.address} onChange={(e) => setAddForm({ ...addForm, address: e.target.value })} rows={2} className="resize-none" />
            </div>
            <div>
              <Label htmlFor="add-address-2" className="text-xs text-gray-500 block mb-1">Address 2 (opsional)</Label>
              <Textarea id="add-address-2" value={addForm.address_2} onChange={(e) => setAddForm({ ...addForm, address_2: e.target.value })} rows={2} className="resize-none" />
            </div>
            <div>
              <Label htmlFor="add-area" className="text-xs text-gray-500 block mb-1">Area</Label>
              <select id="add-area" value={addForm.area} onChange={(e) => setAddForm({ ...addForm, area: e.target.value })} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500">
                <option value="">— Select area —</option>
                {DELIVERY_AREAS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="add-sub-area" className="text-xs text-gray-500 block mb-1">Sub Area</Label>
              <Input id="add-sub-area" value={addForm.sub_area} onChange={(e) => setAddForm({ ...addForm, sub_area: e.target.value })} placeholder="e.g. Binus, Pacific Garden" />
            </div>
            <div>
              <Label htmlFor="add-maps" className="text-xs text-gray-500 block mb-1">Google Maps Link</Label>
              <Input id="add-maps" value={addForm.google_maps_link} onChange={(e) => setAddForm({ ...addForm, google_maps_link: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="add-sub" className="text-xs text-gray-500 block mb-1">Assigned Subcontractor</Label>
              <select id="add-sub" value={addForm.subcontractor_id} onChange={(e) => setAddForm({ ...addForm, subcontractor_id: e.target.value })} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500">
                <option value="">— None —</option>
                {(subcontractors ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            {addError && <p className="text-xs text-red-600">{addError}</p>}

            <div className="flex gap-2 pt-1">
              <Button type="button" onClick={submitAdd} disabled={createMutation.isPending} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40">{createMutation.isPending ? "Menyimpan..." : "Simpan"}</Button>
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)} className="flex-1 py-2 border-gray-200 text-sm rounded-lg">Batal</Button>
            </div>
          </div>
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            aria-label="Close"
            className="absolute inset-0 h-auto w-auto rounded-none bg-black/20 cursor-default hover:bg-black/20"
            onClick={() => setSelected(null)}
          />
          <div className="relative w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                Customer Detail
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-600 h-auto p-0"
              >
                ✕
              </Button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <Label htmlFor="customer-phone" className="text-xs text-gray-500 block mb-1">
                  Phone
                </Label>
                <Input
                  id="customer-phone"
                  value={editForm.phone_number}
                  onChange={(e) =>
                    setEditForm({ ...editForm, phone_number: e.target.value })
                  }
                />
              </div>

              <div>
                <Label htmlFor="customer-name" className="text-xs text-gray-500 block mb-1">
                  Name
                </Label>
                <Input
                  id="customer-name"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                />
              </div>

              <div>
                <Label htmlFor="customer-address" className="text-xs text-gray-500 block mb-1">
                  Address
                </Label>
                <Textarea
                  id="customer-address"
                  value={editForm.address}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address: e.target.value })
                  }
                  rows={2}
                  className="resize-none"
                />
              </div>

              <div>
                <Label htmlFor="customer-area" className="text-xs text-gray-500 block mb-1">
                  Area
                </Label>
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
                <Label htmlFor="customer-sub-area" className="text-xs text-gray-500 block mb-1">
                  Sub Area
                </Label>
                <Input
                  id="customer-sub-area"
                  value={editForm.sub_area}
                  onChange={(e) =>
                    setEditForm({ ...editForm, sub_area: e.target.value })
                  }
                  placeholder="e.g. Binus, Pacific Garden"
                />
              </div>

              <div>
                <Label htmlFor="customer-subcontractor" className="text-xs text-gray-500 block mb-1">
                  Assigned Subcontractor
                </Label>
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
                <Label htmlFor="customer-address-type" className="text-xs text-gray-500 block mb-1">
                  Address Type
                </Label>
                <Input
                  id="customer-address-type"
                  value={editForm.address_type}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address_type: e.target.value })
                  }
                  placeholder="e.g. Rumah, Apartment, Kantor"
                />
              </div>

              <div>
                <Label htmlFor="customer-delivery-phone" className="text-xs text-gray-500 block mb-1">
                  Delivery Phone
                </Label>
                <Input
                  id="customer-delivery-phone"
                  value={editForm.delivery_phone}
                  onChange={(e) =>
                    setEditForm({ ...editForm, delivery_phone: e.target.value })
                  }
                  placeholder="Alternative phone for delivery"
                />
              </div>

              <div>
                <Label htmlFor="customer-maps-link" className="text-xs text-gray-500 block mb-1">
                  Google Maps Link
                </Label>
                <Input
                  id="customer-maps-link"
                  value={editForm.google_maps_link}
                  onChange={(e) =>
                    setEditForm({ ...editForm, google_maps_link: e.target.value })
                  }
                  placeholder="https://maps.app.goo.gl/..."
                />
              </div>

              <div className="pt-1 pb-0.5">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Address 2</p>
              </div>

              <div>
                <Label htmlFor="customer-address-2" className="text-xs text-gray-500 block mb-1">
                  Address 2
                </Label>
                <Textarea
                  id="customer-address-2"
                  value={editForm.address_2}
                  onChange={(e) => setEditForm({ ...editForm, address_2: e.target.value })}
                  rows={2}
                  className="resize-none"
                />
              </div>

              <div>
                <Label htmlFor="customer-area-2" className="text-xs text-gray-500 block mb-1">
                  Area 2
                </Label>
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
                <Label htmlFor="customer-sub-area-2" className="text-xs text-gray-500 block mb-1">
                  Sub Area 2
                </Label>
                <Input
                  id="customer-sub-area-2"
                  value={editForm.sub_area_2}
                  onChange={(e) => setEditForm({ ...editForm, sub_area_2: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="customer-maps-link-2" className="text-xs text-gray-500 block mb-1">
                  Google Maps Link 2
                </Label>
                <Input
                  id="customer-maps-link-2"
                  value={editForm.google_maps_link_2}
                  onChange={(e) => setEditForm({ ...editForm, google_maps_link_2: e.target.value })}
                  placeholder="https://maps.app.goo.gl/..."
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-meal-time"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Meal Time Preference
                </Label>
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
                <Label className="text-xs text-gray-500 block mb-1">Ad Creative</Label>
                <Input
                  value={editForm.ad_creative}
                  onChange={(e) => setEditForm({ ...editForm, ad_creative: e.target.value })}
                  placeholder="e.g. C4"
                />
              </div>

              <div>
                <Label className="text-xs text-gray-500 block mb-1">Promo Used</Label>
                <Input
                  value={editForm.promo_used}
                  onChange={(e) => setEditForm({ ...editForm, promo_used: e.target.value })}
                  placeholder="e.g. Rp17k porsi pertama"
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
                <Label htmlFor="converted-to-subscription" className="text-sm text-gray-700">
                  Converted to subscription
                </Label>
              </div>

              <div>
                <Label className="text-xs text-gray-500 block mb-1">Notes</Label>
                <Textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={3}
                  className="resize-none"
                />
              </div>

              {/* Draw ledger — every package credit (+N) and daily draw (−N) */}
              <div className="pt-2 border-t border-gray-100">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    Riwayat pemakaian
                  </p>
                  {ledger && (
                    <span className="text-xs text-gray-500">
                      sisa{" "}
                      <span
                        className={`font-semibold ${ledger.balance < 0 ? "text-red-600" : "text-gray-900"}`}
                      >
                        {ledger.balance}
                      </span>{" "}
                      porsi
                    </span>
                  )}
                </div>
                {ledgerLoading ? (
                  <p className="text-xs text-gray-400">Memuat…</p>
                ) : !ledger || ledger.rows.length === 0 ? (
                  <p className="text-xs text-gray-400">Belum ada transaksi.</p>
                ) : (
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="text-left font-medium px-2 py-1.5">Tanggal</th>
                          <th className="text-left font-medium px-2 py-1.5">Keterangan</th>
                          <th className="text-right font-medium px-2 py-1.5">Jumlah</th>
                          <th className="text-right font-medium px-2 py-1.5">Sisa</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledger.rows.map((r) => (
                          <tr
                            key={r.id}
                            className={`border-t border-gray-50 ${r.scheduled ? "text-gray-400" : "text-gray-700"}`}
                          >
                            <td className="px-2 py-1.5 whitespace-nowrap">{formatDate(r.date)}</td>
                            <td className="px-2 py-1.5">
                              {r.kind === "package" ? (
                                <span className="font-medium text-gray-900">{r.label}</span>
                              ) : (
                                <span className="capitalize">
                                  {r.meal_type ?? "draw"}
                                  {r.scheduled ? " · terjadwal" : ""}
                                </span>
                              )}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right font-medium tabular-nums ${r.change < 0 ? "text-red-600" : "text-green-600"}`}
                            >
                              {r.change > 0 ? `+${r.change}` : r.change}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right tabular-nums ${r.balance < 0 ? "text-red-600" : ""}`}
                            >
                              {r.balance}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
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

              <Button
                type="button"
                onClick={() => saveMutation.mutate(editForm)}
                disabled={saveMutation.isPending}
                className="w-full bg-orange-500 hover:bg-orange-600"
              >
                {saveMutation.isPending ? "Saving..." : "Save changes"}
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteConfirmOpen(true)}
                className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              >
                Delete customer
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete customer confirm */}
      {deleteConfirmOpen && selected && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <Button
            type="button"
            variant="ghost"
            aria-label="Close"
            className="absolute inset-0 h-auto w-auto rounded-none bg-black/40 cursor-default hover:bg-black/40"
            onClick={() => setDeleteConfirmOpen(false)}
          />
          <div className="relative w-full max-w-sm bg-white rounded-lg shadow-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Delete customer?</h3>
            <p className="text-sm text-gray-600">
              This permanently deletes <span className="font-medium">{selected.name ?? "this customer"}</span>{" "}
              along with their orders, deliveries, conversations, and state. This cannot be undone.
            </p>
            {deleteMutation.isError && (
              <p className="text-sm text-red-600">
                {(deleteMutation.error as Error).message}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => deleteMutation.mutate(selected.id)}
                disabled={deleteMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete permanently"}
              </Button>
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
