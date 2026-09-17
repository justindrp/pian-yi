"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  EVENT_LEAD_STATUSES,
  type EventLeadStatus,
} from "@/lib/events/lead-status";

type EventLead = {
  id: string;
  customer_id: string;
  event_date: string | null;
  portions: number | null;
  venue: string | null;
  brief: string | null;
  status: EventLeadStatus;
  quoted_price_per_portion: number | null;
  notes: string | null;
  created_at: string;
  customers: { id: string; name: string | null; phone_number: string } | null;
  subcontractors: { customer_nickname: string | null } | null;
};

const LABEL: Record<EventLeadStatus, string> = {
  brief: "Brief",
  tendered: "Ditender",
  quoted: "Sudah dikutip",
  won: "Jadi",
  lost: "Batal",
};

/** Days from today to the event, in WIB, or null when the lead has no date. */
function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const today = new Date(Date.now() + 7 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const ms =
    new Date(`${date}T00:00:00Z`).getTime() -
    new Date(`${today}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

export default function EventLeadsPanel() {
  const qc = useQueryClient();
  const [showClosed, setShowClosed] = useState(false);

  const { data: leads = [] } = useQuery<EventLead[]>({
    queryKey: ["event-leads", showClosed],
    queryFn: async () => {
      const res = await fetch(`/api/event-leads${showClosed ? "?all=1" : ""}`);
      const json = await res.json();
      return json.data ?? [];
    },
  });

  const patch = useMutation({
    mutationFn: async ({
      id,
      ...body
    }: { id: string } & Partial<
      Pick<EventLead, "status" | "notes" | "quoted_price_per_portion">
    >) => {
      await fetch(`/api/event-leads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["event-leads"] }),
  });

  if (leads.length === 0 && !showClosed) return null;

  return (
    <div className="mb-6 border border-amber-200 bg-amber-50/50 rounded-lg p-4">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Acara — belum jadi order
        </h2>
        <p className="text-xs text-gray-500">
          Ditender ke dapur, harganya dari penawaran mereka. Tidak pernah dari
          daftar harga harian.
        </p>
        <button
          type="button"
          onClick={() => setShowClosed((v) => !v)}
          className="ml-auto text-xs text-gray-500 hover:text-gray-800 underline"
        >
          {showClosed ? "Sembunyikan yang selesai" : "Tampilkan yang selesai"}
        </button>
      </div>

      <div className="space-y-2">
        {leads.map((lead) => {
          const days = daysUntil(lead.event_date);
          const open = lead.status !== "won" && lead.status !== "lost";
          // Red once the event is inside two days and nobody has closed it —
          // the tender takes a day and the kitchen shops the day before.
          const urgent = open && days !== null && days <= 2;
          return (
            <div
              key={lead.id}
              className="bg-white border border-gray-200 rounded-md p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-gray-900">
                  {lead.customers?.name || lead.customers?.phone_number || "—"}
                </span>
                <span className="text-gray-600">
                  {lead.portions ? `${lead.portions} porsi` : "porsi ?"}
                </span>
                <span
                  className={
                    urgent ? "font-medium text-red-600" : "text-gray-600"
                  }
                >
                  {lead.event_date ?? "tanggal ?"}
                  {days === null
                    ? ""
                    : days < 0
                      ? " (lewat)"
                      : days === 0
                        ? " (hari ini)"
                        : ` (H-${days})`}
                </span>
                {lead.venue ? (
                  <span className="text-gray-500 truncate max-w-xs">
                    {lead.venue}
                  </span>
                ) : null}
                {lead.subcontractors?.customer_nickname ? (
                  <span className="text-gray-500">
                    {lead.subcontractors.customer_nickname}
                  </span>
                ) : null}
                <select
                  value={lead.status}
                  onChange={(e) =>
                    patch.mutate({
                      id: lead.id,
                      status: e.target.value as EventLeadStatus,
                    })
                  }
                  className="ml-auto border border-gray-200 rounded-md px-2 py-1 text-xs"
                >
                  {EVENT_LEAD_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
              {lead.brief ? (
                <p className="mt-1 text-xs text-gray-500">{lead.brief}</p>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <Input
                  className="h-7 w-32 text-xs"
                  placeholder="Harga/porsi"
                  defaultValue={lead.quoted_price_per_portion ?? ""}
                  onBlur={(e) => {
                    const raw = e.target.value.replace(/\D/g, "");
                    const next = raw ? Number(raw) : null;
                    if (next !== lead.quoted_price_per_portion)
                      patch.mutate({
                        id: lead.id,
                        quoted_price_per_portion: next,
                      });
                  }}
                />
                <Input
                  className="h-7 flex-1 text-xs"
                  placeholder="Catatan — hasil tender, apa isi box-nya, siapa yang ditanya"
                  defaultValue={lead.notes ?? ""}
                  onBlur={(e) => {
                    if (e.target.value !== (lead.notes ?? ""))
                      patch.mutate({ id: lead.id, notes: e.target.value });
                  }}
                />
              </div>
            </div>
          );
        })}
        {leads.length === 0 ? (
          <p className="text-xs text-gray-500">Tidak ada acara.</p>
        ) : null}
      </div>
    </div>
  );
}
