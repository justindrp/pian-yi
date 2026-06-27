"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface JournalLine {
  journal_id: string;
  debit: number;
  credit: number;
  account: { code: string; name: string } | null;
}

interface Journal {
  id: string;
  reference: string;
  description: string;
  date: string;
  source_type: string;
  created_at: string;
  lines: JournalLine[];
}

function formatRp(n: number) {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

export default function AccountingClient() {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = `${today.slice(0, 8)}01`;

  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["accounting", from, to, page],
    queryFn: async () => {
      const params = new URLSearchParams({ from, to, page: String(page) });
      const res = await fetch(`/api/accounting?${params}`);
      const json = await res.json();
      return json as {
        ok: boolean;
        data: Journal[];
        total: number;
        page: number;
        pageSize: number;
      };
    },
  });

  const journals = data?.data ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Accounting</h1>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-100 p-4 mb-4 flex flex-wrap gap-4 items-end">
        <div>
          <Label className="block text-xs text-gray-500 mb-1">Dari</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <Label className="block text-xs text-gray-500 mb-1">Sampai</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <p className="text-sm text-gray-400 self-end pb-2">{total} jurnal</p>
      </div>

      {/* Journal list */}
      <div className="space-y-2">
        {isLoading && (
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
            Memuat...
          </div>
        )}
        {!isLoading && journals.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
            Tidak ada jurnal pada periode ini.
          </div>
        )}
        {journals.map((j) => {
          const isOpen = expanded === j.id;
          const totalDebit = j.lines.reduce((s, l) => s + l.debit, 0);
          return (
            <div
              key={j.id}
              className="bg-white rounded-xl border border-gray-100 overflow-hidden"
            >
              <Button
                type="button"
                variant="ghost"
                onClick={() => setExpanded(isOpen ? null : j.id)}
                className="w-full flex items-center justify-between px-4 py-3 h-auto text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-gray-400 w-28 shrink-0">
                    {j.reference}
                  </span>
                  <div>
                    <p className="text-sm text-gray-800">{j.description}</p>
                    <p className="text-xs text-gray-400">
                      {j.date} ·{" "}
                      {j.source_type === "order_payment"
                        ? "Pembayaran"
                        : "Pengiriman"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium text-gray-700">
                    {formatRp(totalDebit)}
                  </span>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    role="img"
                    aria-label="Toggle details"
                    className={`text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </div>
              </Button>

              {isOpen && (
                <div className="border-t border-gray-100 px-4 py-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400">
                        <th className="text-left pb-2 font-normal w-16">
                          Kode
                        </th>
                        <th className="text-left pb-2 font-normal">Akun</th>
                        <th className="text-right pb-2 font-normal w-28">
                          Debit
                        </th>
                        <th className="text-right pb-2 font-normal w-28">
                          Kredit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {j.lines.map((line) => (
                        <tr key={`${line.journal_id}-${line.account?.code}`} className="border-t border-gray-50">
                          <td className="py-1.5 text-gray-400 font-mono">
                            {line.account?.code}
                          </td>
                          <td className="py-1.5 text-gray-700">
                            {line.account?.name}
                          </td>
                          <td className="py-1.5 text-right text-gray-700">
                            {line.debit > 0 ? formatRp(line.debit) : "—"}
                          </td>
                          <td className="py-1.5 text-right text-gray-700">
                            {line.credit > 0 ? formatRp(line.credit) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-200">
                        <td colSpan={2} className="pt-2 text-gray-400">
                          Total
                        </td>
                        <td className="pt-2 text-right font-medium text-gray-800">
                          {formatRp(j.lines.reduce((s, l) => s + l.debit, 0))}
                        </td>
                        <td className="pt-2 text-right font-medium text-gray-800">
                          {formatRp(j.lines.reduce((s, l) => s + l.credit, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Prev
          </Button>
          <span className="px-3 py-1.5 text-sm text-gray-500">
            {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
