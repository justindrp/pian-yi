"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Customer {
  id: string;
  name: string | null;
  phone_number: string;
  area: string | null;
  sub_area: string | null;
  address: string | null;
  subcontractor_id: string | null;
}

interface Subcontractor {
  id: string;
  name: string;
  customer_nickname: string | null;
}

interface ScheduleSlot {
  date: string;
  meal_type: "lunch" | "dinner";
  portions: number;
}

const MEAL_PREFS = [
  { value: "lunch_only", label: "Lunch only" },
  { value: "dinner_only", label: "Dinner only" },
  { value: "both_fixed", label: "Both (lunch + dinner)" },
];

// Radix Select forbids an empty-string item value; use this sentinel for "no subcontractor".
const NO_SUBCONTRACTOR = "__none__";

const WEEKDAY_LABELS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]; // Mon–Fri

function generateDates(
  start: string,
  end: string,
  weekdays: number[],
): string[] {
  if (!start || !end || weekdays.length === 0) return [];
  const result: string[] = [];
  const cur = new Date(start);
  const endDate = new Date(end);
  while (cur <= endDate) {
    if (weekdays.includes(cur.getDay())) {
      result.push(cur.toISOString().slice(0, 10));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export default function NewOrderModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [orderType, setOrderType] = useState<"recurring" | "scheduled" | null>(null);

  // Customer search
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerComboRef = useRef<HTMLDivElement>(null);

  // Inline new-customer creation (for a customer who ordered a package manually
  // and isn't in the system yet).
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [creatingError, setCreatingError] = useState("");
  const [newCust, setNewCust] = useState({ name: "", phone_number: "", area: "", address: "", subcontractor_id: "" });

  // Common fields
  const [pricePerPortion, setPricePerPortion] = useState("28000");
  const [portionsPerDelivery, setPortionsPerDelivery] = useState("1");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [area, setArea] = useState("");
  const [subcontractorId, setSubcontractorId] = useState<string>("");
  const [status, setStatus] = useState<"pending_payment" | "active" | "completed">("active");

  // Recurring-specific
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [mealPref, setMealPref] = useState("lunch_only");
  const [packageSize, setPackageSize] = useState("20");
  const [portionsLunch, setPortionsLunch] = useState("");
  const [portionsDinner, setPortionsDinner] = useState("");

  const [size, setSize] = useState<"s" | "m">("s");

  // Scheduled-specific
  const [schedStart, setSchedStart] = useState("2026-01-01");
  const [schedEnd, setSchedEnd] = useState(new Date().toISOString().slice(0, 10));
  const [weekdays, setWeekdays] = useState<number[]>(DEFAULT_WEEKDAYS);
  const [schedMeal, setSchedMeal] = useState<"lunch" | "dinner" | "both">("lunch");
  const [schedule, setSchedule] = useState<ScheduleSlot[]>([]);
  const [scheduleGenerated, setScheduleGenerated] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (customerComboRef.current && !customerComboRef.current.contains(e.target as Node)) {
        setShowCustomerDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/customers").then((r) => r.json()),
      fetch("/api/subcontractors").then((r) => r.json()),
    ]).then(([cRes, sRes]) => {
      if (cRes.ok) setCustomers(cRes.data ?? []);
      else console.error("[NewOrderModal] customers fetch error:", cRes);
      if (sRes.ok) setSubcontractors(sRes.data ?? []);
      else console.error("[NewOrderModal] subcontractors fetch error:", sRes);
    }).catch((err) => console.error("[NewOrderModal] fetch failed:", err));
  }, []);

  function selectCustomer(c: Customer) {
    setSelectedCustomer(c);
    setCustomerSearch(c.name ?? c.phone_number);
    setShowCustomerDropdown(false);
    setDeliveryAddress(c.address ?? "");
    setArea(c.area ?? "");
    setSubcontractorId(c.subcontractor_id ?? "");
  }

  function openCreateCustomer() {
    setShowCustomerDropdown(false);
    setCreatingError("");
    // Prefill phone if the search box looks like a number.
    const looksLikePhone = /[0-9]/.test(customerSearch) && !/[a-z]/i.test(customerSearch);
    setNewCust({ name: "", phone_number: looksLikePhone ? customerSearch.trim() : "", area: "", address: "", subcontractor_id: "" });
    setCreatingCustomer(true);
  }

  async function createCustomerInline() {
    setCreatingError("");
    if (!newCust.phone_number.trim()) {
      setCreatingError("Nomor telepon wajib diisi");
      return;
    }
    setCreatingBusy(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newCust),
      });
      const json = (await res.json()) as { ok: boolean; error?: string; data?: Customer };
      if (!json.ok || !json.data) {
        setCreatingError(json.error ?? "Gagal membuat pelanggan");
        return;
      }
      setCustomers((prev) => [json.data as Customer, ...prev]);
      selectCustomer(json.data);
      setCreatingCustomer(false);
    } catch {
      setCreatingError("Gagal membuat pelanggan");
    } finally {
      setCreatingBusy(false);
    }
  }

  function toggleWeekday(day: number) {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
    setScheduleGenerated(false);
  }

  function generateSchedule() {
    const dates = generateDates(schedStart, schedEnd, weekdays);
    const portions = Number(portionsPerDelivery) || 1;
    const slots: ScheduleSlot[] = [];
    for (const date of dates) {
      if (schedMeal === "lunch" || schedMeal === "both") {
        slots.push({ date, meal_type: "lunch", portions });
      }
      if (schedMeal === "dinner" || schedMeal === "both") {
        slots.push({ date, meal_type: "dinner", portions });
      }
    }
    setSchedule(slots);
    setScheduleGenerated(true);
  }

  function removeSlot(idx: number) {
    setSchedule((prev) => prev.filter((_, i) => i !== idx));
  }

  const totalPortions = schedule.reduce((s, r) => s + r.portions, 0);
  const totalPrice = totalPortions * (Number(pricePerPortion) || 0);

  async function handleSubmit() {
    if (!selectedCustomer) {
      setError("Pilih pelanggan terlebih dahulu.");
      return;
    }
    setError("");
    setSubmitting(true);

    try {
      const common = {
        customer_id: selectedCustomer.id,
        order_type: orderType,
        price_per_portion: Number(pricePerPortion) + (size === "m" ? 2000 : 0),
        portions_per_delivery: Number(portionsPerDelivery),
        delivery_address: deliveryAddress,
        area,
        subcontractor_id: subcontractorId || null,
        status,
      };

      const body =
        orderType === "recurring"
          ? {
              ...common,
              start_date: startDate,
              end_date: endDate || undefined,
              meal_time_preference: mealPref,
              package_size: Number(packageSize),
              size,
              portions_lunch: portionsLunch ? Number(portionsLunch) : undefined,
              portions_dinner: portionsDinner ? Number(portionsDinner) : undefined,
            }
          : {
              ...common,
              delivery_schedule: schedule,
            };

      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { ok: boolean; error?: string };

      if (!json.ok) {
        setError(json.error ?? "Gagal membuat order.");
        return;
      }

      onSuccess();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col">
        {/* Non-scrolling header: title + customer combobox (must stay outside overflow container) */}
        <div className="px-6 pt-6 pb-0">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-gray-900">Order Baru</h2>
            <Button type="button" variant="ghost" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none h-auto w-auto p-0">&times;</Button>
          </div>

          {/* Step 0: Customer */}
          <div className="mb-5" ref={customerComboRef}>
            <Label htmlFor="new-order-customer" className="block text-sm font-medium text-gray-700 mb-1">Pelanggan</Label>
            <div className="relative">
              <Input
                id="new-order-customer"
                type="text"
                value={customerSearch}
                placeholder="Cari nama atau nomor..."
                onChange={(e) => {
                  setCustomerSearch(e.target.value);
                  setSelectedCustomer(null);
                  setShowCustomerDropdown(true);
                }}
                onFocus={() => setShowCustomerDropdown(true)}
                className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
              />
              {showCustomerDropdown && (
                <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                  {(customerSearch.trim() === ""
                    ? customers
                    : customers.filter((c) => {
                        const q = customerSearch.toLowerCase();
                        return (
                          (c.name ?? "").toLowerCase().includes(q) ||
                          c.phone_number.includes(q)
                        );
                      })
                  ).map((c) => (
                    <li
                      key={c.id}
                      onMouseDown={(e) => { e.preventDefault(); selectCustomer(c); }}
                      className="px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 flex justify-between"
                    >
                      <span className="text-gray-900">{c.name ?? c.phone_number}</span>
                      <span className="text-gray-400 text-xs">{c.area}</span>
                    </li>
                  ))}
                  {customers.length > 0 &&
                    customerSearch.trim() !== "" &&
                    customers.filter((c) => {
                      const q = customerSearch.toLowerCase();
                      return (c.name ?? "").toLowerCase().includes(q) || c.phone_number.includes(q);
                    }).length === 0 && (
                      <li className="px-3 py-2 text-sm text-gray-400">Tidak ditemukan</li>
                    )}
                  <li
                    onMouseDown={(e) => { e.preventDefault(); openCreateCustomer(); }}
                    className="px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 text-blue-600 font-medium border-t border-gray-100 sticky bottom-0 bg-white"
                  >
                    + Buat pelanggan baru
                  </li>
                </ul>
              )}
            </div>

            {creatingCustomer && (
              <div className="mt-3 border border-blue-200 bg-blue-50/40 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">Pelanggan baru</span>
                  <Button type="button" variant="ghost" onClick={() => setCreatingCustomer(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none h-auto w-auto p-0">&times;</Button>
                </div>
                <Input value={newCust.phone_number} onChange={(e) => setNewCust({ ...newCust, phone_number: e.target.value })} placeholder="Nomor telepon (+628...) *" className="text-sm h-auto" />
                <Input value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} placeholder="Nama" className="text-sm h-auto" />
                <Input value={newCust.address} onChange={(e) => setNewCust({ ...newCust, address: e.target.value })} placeholder="Alamat" className="text-sm h-auto" />
                <Input value={newCust.area} onChange={(e) => setNewCust({ ...newCust, area: e.target.value })} placeholder="Area" className="text-sm h-auto" />
                <Select value={newCust.subcontractor_id || NO_SUBCONTRACTOR} onValueChange={(v) => setNewCust({ ...newCust, subcontractor_id: v === NO_SUBCONTRACTOR ? "" : v })}>
                  <SelectTrigger className="text-sm h-auto"><SelectValue placeholder="Dapur" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SUBCONTRACTOR}>— Dapur —</SelectItem>
                    {subcontractors.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {creatingError && <p className="text-xs text-red-600">{creatingError}</p>}
                <Button type="button" onClick={createCustomerInline} disabled={creatingBusy} className="w-full py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40 h-auto">{creatingBusy ? "Menyimpan..." : "Buat & pilih"}</Button>
              </div>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 pb-4">

        {/* Step 1: Order type */}
        <div className="mb-5">
          <p className="block text-sm font-medium text-gray-700 mb-2">Tipe Order</p>
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setOrderType("scheduled"); setStep(2); }}
              className={`flex flex-col items-start justify-start h-auto border rounded-lg p-3 text-left transition-colors ${orderType === "scheduled" ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <div className="font-medium text-sm text-gray-900">Scheduled</div>
              <div className="text-xs text-gray-500 mt-0.5">Pilih tanggal-tanggal spesifik</div>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setOrderType("recurring"); setStep(2); }}
              className={`flex flex-col items-start justify-start h-auto border rounded-lg p-3 text-left transition-colors ${orderType === "recurring" ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <div className="font-medium text-sm text-gray-900">Recurring</div>
              <div className="text-xs text-gray-500 mt-0.5">Cron generate otomatis tiap hari</div>
            </Button>
          </div>
        </div>

        {/* Step 2: Fields */}
        {step === 2 && orderType && (
          <>
            {/* Common fields */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <Label htmlFor="new-order-price-per-portion" className="block text-xs font-medium text-gray-600 mb-1">Harga / porsi (Rp)</Label>
                <Input
                  id="new-order-price-per-portion"
                  type="number"
                  value={pricePerPortion}
                  onChange={(e) => setPricePerPortion(e.target.value)}
                  className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                />
              </div>
              <div>
                <Label htmlFor="new-order-portions-per-delivery" className="block text-xs font-medium text-gray-600 mb-1">Porsi / pengiriman</Label>
                <Input
                  id="new-order-portions-per-delivery"
                  type="number"
                  value={portionsPerDelivery}
                  onChange={(e) => setPortionsPerDelivery(e.target.value)}
                  className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                />
              </div>
              <div>
                <Label htmlFor="new-order-area" className="block text-xs font-medium text-gray-600 mb-1">Area</Label>
                <Input
                  id="new-order-area"
                  type="text"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                />
              </div>
              <div>
                <Label htmlFor="new-order-subcontractor" className="block text-xs font-medium text-gray-600 mb-1">Subkontraktor</Label>
                <Select
                  value={subcontractorId || NO_SUBCONTRACTOR}
                  onValueChange={(v) => setSubcontractorId(v === NO_SUBCONTRACTOR ? "" : v)}
                >
                  <SelectTrigger id="new-order-subcontractor" className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SUBCONTRACTOR}>— Tidak ada —</SelectItem>
                    {subcontractors.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.customer_nickname ?? s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label htmlFor="new-order-delivery-address" className="block text-xs font-medium text-gray-600 mb-1">Alamat pengiriman</Label>
                <Input
                  id="new-order-delivery-address"
                  type="text"
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                />
              </div>
              <div>
                <Label htmlFor="new-order-status" className="block text-xs font-medium text-gray-600 mb-1">Status order</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                  <SelectTrigger id="new-order-status" className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="pending_payment">Pending Payment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Recurring-specific */}
            {orderType === "recurring" && (
              <div className="grid grid-cols-2 gap-3 mb-4 border-t pt-4">
                <div>
                  <Label htmlFor="new-order-start-date" className="block text-xs font-medium text-gray-600 mb-1">Tanggal mulai</Label>
                  <Input
                    id="new-order-start-date"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                  />
                </div>
                <div>
                  <Label htmlFor="new-order-end-date" className="block text-xs font-medium text-gray-600 mb-1">Tanggal selesai (opsional)</Label>
                  <Input
                    id="new-order-end-date"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                  />
                </div>
                <div>
                  <Label htmlFor="new-order-package-size" className="block text-xs font-medium text-gray-600 mb-1">Total porsi (package size)</Label>
                  <Input
                    id="new-order-package-size"
                    type="number"
                    value={packageSize}
                    onChange={(e) => setPackageSize(e.target.value)}
                    className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                  />
                </div>
                <div>
                  <Label htmlFor="new-order-meal-pref" className="block text-xs font-medium text-gray-600 mb-1">Preferensi makan</Label>
                  <Select value={mealPref} onValueChange={setMealPref}>
                    <SelectTrigger id="new-order-meal-pref" className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEAL_PREFS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {(mealPref === "both_fixed") && (
                  <>
                    <div>
                      <Label htmlFor="new-order-portions-lunch" className="block text-xs font-medium text-gray-600 mb-1">Porsi lunch</Label>
                      <Input
                        id="new-order-portions-lunch"
                        type="number"
                        value={portionsLunch}
                        onChange={(e) => setPortionsLunch(e.target.value)}
                        className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                      />
                    </div>
                    <div>
                      <Label htmlFor="new-order-portions-dinner" className="block text-xs font-medium text-gray-600 mb-1">Porsi dinner</Label>
                      <Input
                        id="new-order-portions-dinner"
                        type="number"
                        value={portionsDinner}
                        onChange={(e) => setPortionsDinner(e.target.value)}
                        className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                      />
                    </div>
                  </>
                )}
                <div className="col-span-2">
                  <p className="block text-xs font-medium text-gray-600 mb-1">Ukuran</p>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => setSize("s")} className={`px-4 py-2 text-sm rounded-lg border h-auto ${size === "s" ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-700"}`}>S (Standar)</Button>
                    <Button type="button" variant="outline" onClick={() => setSize("m")} className={`px-4 py-2 text-sm rounded-lg border h-auto ${size === "m" ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-700"}`}>M (+Rp 2.000/porsi)</Button>
                  </div>
                </div>
                <div className="col-span-2 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600">
                  Total: {packageSize} porsi × Rp {(Number(pricePerPortion) + (size === "m" ? 2000 : 0)).toLocaleString("id-ID")} = <span className="font-semibold text-gray-900">Rp {(Number(packageSize) * (Number(pricePerPortion) + (size === "m" ? 2000 : 0))).toLocaleString("id-ID")}</span>
                </div>
              </div>
            )}

            {/* Scheduled-specific */}
            {orderType === "scheduled" && (
              <div className="border-t pt-4 mb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="new-order-sched-start" className="block text-xs font-medium text-gray-600 mb-1">Dari tanggal</Label>
                    <Input
                      id="new-order-sched-start"
                      type="date"
                      value={schedStart}
                      min="2026-01-01"
                      onChange={(e) => { setSchedStart(e.target.value); setScheduleGenerated(false); }}
                      className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-order-sched-end" className="block text-xs font-medium text-gray-600 mb-1">Sampai tanggal</Label>
                    <Input
                      id="new-order-sched-end"
                      type="date"
                      value={schedEnd}
                      min="2026-01-01"
                      onChange={(e) => { setSchedEnd(e.target.value); setScheduleGenerated(false); }}
                      className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
                    />
                  </div>
                </div>

                <div>
                  <p className="block text-xs font-medium text-gray-600 mb-1">Hari pengiriman</p>
                  <div className="flex gap-1">
                    {WEEKDAY_LABELS.map((label, i) => (
                      <Button
                        key={label}
                        type="button"
                        variant="ghost"
                        onClick={() => toggleWeekday(i)}
                        className={`px-2.5 py-1 rounded text-xs font-medium h-auto transition-colors ${weekdays.includes(i) ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="block text-xs font-medium text-gray-600 mb-1">Waktu makan</p>
                  <RadioGroup
                    value={schedMeal}
                    onValueChange={(v) => { setSchedMeal(v as "lunch" | "dinner" | "both"); setScheduleGenerated(false); }}
                    className="flex gap-2"
                  >
                    {(["lunch", "dinner", "both"] as const).map((m) => (
                      <Label key={m} htmlFor={`sched-meal-${m}`} className="flex items-center gap-1.5 text-sm cursor-pointer font-normal">
                        <RadioGroupItem id={`sched-meal-${m}`} value={m} />
                        {m === "lunch" ? "Lunch" : m === "dinner" ? "Dinner" : "Keduanya"}
                      </Label>
                    ))}
                  </RadioGroup>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  onClick={generateSchedule}
                  className="w-full border-blue-500 text-blue-600 rounded-lg py-2 text-sm font-medium h-auto hover:bg-blue-50 transition-colors"
                >
                  Generate jadwal
                </Button>

                {scheduleGenerated && schedule.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-2">Tidak ada tanggal yang cocok.</p>
                )}

                {schedule.length > 0 && (
                  <>
                    <div className="bg-blue-50 rounded-lg px-3 py-2 text-sm text-gray-700">
                      {schedule.length} pengiriman · {totalPortions} porsi × Rp {Number(pricePerPortion).toLocaleString("id-ID")} = <span className="font-semibold text-gray-900">Rp {totalPrice.toLocaleString("id-ID")}</span>
                    </div>
                    <div className="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                      {schedule.map((slot, idx) => (
                        <div key={`${slot.date}-${slot.meal_type}`} className="flex items-center justify-between px-3 py-1.5 text-sm">
                          <span className="text-gray-700">{formatDate(slot.date)}</span>
                          <span className="text-gray-400 capitalize">{slot.meal_type}</span>
                          <span className="text-gray-700">{slot.portions} porsi</span>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => removeSlot(idx)}
                            className="text-gray-300 hover:text-red-400 text-lg leading-none ml-2 h-auto w-auto p-0"
                          >
                            &times;
                          </Button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        </div>{/* end scrollable body */}

        <div className="px-6 pb-6">
        {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

        <div className="flex gap-3 justify-end pt-2 border-t">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 h-auto"
          >
            Batal
          </Button>
          {step === 2 && (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={
                submitting ||
                !selectedCustomer ||
                (orderType === "scheduled" && schedule.length === 0)
              }
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed h-auto"
            >
              {submitting ? "Menyimpan..." : "Simpan Order"}
            </Button>
          )}
        </div>
        </div>{/* end footer */}
      </div>
    </div>
  );
}
