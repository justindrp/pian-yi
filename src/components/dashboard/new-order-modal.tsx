"use client";

import { useEffect, useRef, useState } from "react";

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
        price_per_portion: Number(pricePerPortion),
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
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>

          {/* Step 0: Customer */}
          <div className="mb-5" ref={customerComboRef}>
            <label className="block text-sm font-medium text-gray-700 mb-1">Pelanggan</label>
            <div className="relative">
              <input
                type="text"
                value={customerSearch}
                placeholder="Cari nama atau nomor..."
                onChange={(e) => {
                  setCustomerSearch(e.target.value);
                  setSelectedCustomer(null);
                  setShowCustomerDropdown(true);
                }}
                onFocus={() => setShowCustomerDropdown(true)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
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
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 pb-4">

        {/* Step 1: Order type */}
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-2">Tipe Order</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => { setOrderType("scheduled"); setStep(2); }}
              className={`border rounded-lg p-3 text-left transition-colors ${orderType === "scheduled" ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <div className="font-medium text-sm text-gray-900">Scheduled</div>
              <div className="text-xs text-gray-500 mt-0.5">Pilih tanggal-tanggal spesifik</div>
            </button>
            <button
              type="button"
              onClick={() => { setOrderType("recurring"); setStep(2); }}
              className={`border rounded-lg p-3 text-left transition-colors ${orderType === "recurring" ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <div className="font-medium text-sm text-gray-900">Recurring</div>
              <div className="text-xs text-gray-500 mt-0.5">Cron generate otomatis tiap hari</div>
            </button>
          </div>
        </div>

        {/* Step 2: Fields */}
        {step === 2 && orderType && (
          <>
            {/* Common fields */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Harga / porsi (Rp)</label>
                <input
                  type="number"
                  value={pricePerPortion}
                  onChange={(e) => setPricePerPortion(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Porsi / pengiriman</label>
                <input
                  type="number"
                  value={portionsPerDelivery}
                  onChange={(e) => setPortionsPerDelivery(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Area</label>
                <input
                  type="text"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Subkontraktor</label>
                <select
                  value={subcontractorId}
                  onChange={(e) => setSubcontractorId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">— Tidak ada —</option>
                  {subcontractors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.customer_nickname ?? s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Alamat pengiriman</label>
                <input
                  type="text"
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Status order</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="pending_payment">Pending Payment</option>
                </select>
              </div>
            </div>

            {/* Recurring-specific */}
            {orderType === "recurring" && (
              <div className="grid grid-cols-2 gap-3 mb-4 border-t pt-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tanggal mulai</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tanggal selesai (opsional)</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Total porsi (package size)</label>
                  <input
                    type="number"
                    value={packageSize}
                    onChange={(e) => setPackageSize(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Preferensi makan</label>
                  <select
                    value={mealPref}
                    onChange={(e) => setMealPref(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    {MEAL_PREFS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                {(mealPref === "both_fixed") && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Porsi lunch</label>
                      <input
                        type="number"
                        value={portionsLunch}
                        onChange={(e) => setPortionsLunch(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Porsi dinner</label>
                      <input
                        type="number"
                        value={portionsDinner}
                        onChange={(e) => setPortionsDinner(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}
                <div className="col-span-2 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600">
                  Total: {packageSize} porsi × Rp {Number(pricePerPortion).toLocaleString("id-ID")} = <span className="font-semibold text-gray-900">Rp {(Number(packageSize) * Number(pricePerPortion)).toLocaleString("id-ID")}</span>
                </div>
              </div>
            )}

            {/* Scheduled-specific */}
            {orderType === "scheduled" && (
              <div className="border-t pt-4 mb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Dari tanggal</label>
                    <input
                      type="date"
                      value={schedStart}
                      min="2026-01-01"
                      onChange={(e) => { setSchedStart(e.target.value); setScheduleGenerated(false); }}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Sampai tanggal</label>
                    <input
                      type="date"
                      value={schedEnd}
                      min="2026-01-01"
                      onChange={(e) => { setSchedEnd(e.target.value); setScheduleGenerated(false); }}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Hari pengiriman</label>
                  <div className="flex gap-1">
                    {WEEKDAY_LABELS.map((label, i) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => toggleWeekday(i)}
                        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${weekdays.includes(i) ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Waktu makan</label>
                  <div className="flex gap-2">
                    {(["lunch", "dinner", "both"] as const).map((m) => (
                      <label key={m} className="flex items-center gap-1.5 text-sm cursor-pointer">
                        <input
                          type="radio"
                          checked={schedMeal === m}
                          onChange={() => { setSchedMeal(m); setScheduleGenerated(false); }}
                        />
                        {m === "lunch" ? "Lunch" : m === "dinner" ? "Dinner" : "Keduanya"}
                      </label>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={generateSchedule}
                  className="w-full border border-blue-500 text-blue-600 rounded-lg py-2 text-sm font-medium hover:bg-blue-50 transition-colors"
                >
                  Generate jadwal
                </button>

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
                          <button
                            type="button"
                            onClick={() => removeSlot(idx)}
                            className="text-gray-300 hover:text-red-400 text-lg leading-none ml-2"
                          >
                            &times;
                          </button>
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
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
          >
            Batal
          </button>
          {step === 2 && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={
                submitting ||
                !selectedCustomer ||
                (orderType === "scheduled" && schedule.length === 0)
              }
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Menyimpan..." : "Simpan Order"}
            </button>
          )}
        </div>
        </div>{/* end footer */}
      </div>
    </div>
  );
}
