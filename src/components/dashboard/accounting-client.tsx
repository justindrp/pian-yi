"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ACCOUNT_TYPES = [
  "Asset",
  "Liability",
  "Equity",
  "Revenue",
  "Expense",
] as const;

interface Account {
  code: string;
  name: string;
  type: string;
}

interface ManagedAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
  category: string;
  is_active: boolean;
}

function sourceLabel(t: string) {
  if (t === "order_payment") return "Pembayaran";
  if (t === "manual") return "Manual";
  return "Pengiriman";
}

function formatRp(n: number) {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

type Tab =
  | "jurnal"
  | "buku-besar"
  | "neraca-saldo"
  | "laba-rugi"
  | "neraca"
  | "rekening-koran"
  | "akun";

const TABS: { id: Tab; label: string }[] = [
  { id: "jurnal", label: "Jurnal" },
  { id: "buku-besar", label: "Buku Besar" },
  { id: "neraca-saldo", label: "Neraca Saldo" },
  { id: "laba-rugi", label: "Laba Rugi" },
  { id: "neraca", label: "Neraca" },
  { id: "rekening-koran", label: "Rekening Koran" },
  { id: "akun", label: "Akun" },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

export default function AccountingClient() {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = `${today.slice(0, 8)}01`;

  // Tab, date range and selected account live in the URL. A ledger view worth
  // looking at is worth sending to someone, and a reload that silently resets
  // to "Jurnal, this month" loses the thing you had just found.
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const tabParam = params.get("tab") ?? "";
  const tab: Tab = TAB_IDS.has(tabParam) ? (tabParam as Tab) : "jurnal";
  const from = params.get("from") ?? firstOfMonth;
  const to = params.get("to") ?? today;

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const setTab = (id: Tab) => setParams({ tab: id === "jurnal" ? null : id });
  const setFrom = (v: string) => setParams({ from: v });
  const setTo = (v: string) => setParams({ to: v });

  const showRange =
    tab !== "neraca" && tab !== "akun" && tab !== "rekening-koran";
  const showAsOf = tab === "neraca";

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900 mb-4">Accounting</h1>

      {/* Tab nav */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-gray-900 text-gray-900 font-medium"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Date controls */}
      {(showRange || showAsOf) && (
        <div className="bg-white rounded-xl border border-gray-100 p-4 mb-4 flex flex-wrap gap-4 items-end">
          {showRange && (
            <div>
              <Label className="block text-xs text-gray-500 mb-1">Dari</Label>
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
          )}
          <div>
            <Label className="block text-xs text-gray-500 mb-1">
              {showAsOf ? "Per tanggal" : "Sampai"}
            </Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
      )}

      {tab === "jurnal" && <JournalTab from={from} to={to} />}
      {tab === "buku-besar" && <LedgerTab from={from} to={to} />}
      {tab === "neraca-saldo" && <TrialBalanceTab from={from} to={to} />}
      {tab === "laba-rugi" && <PnlTab from={from} to={to} />}
      {tab === "neraca" && <BalanceSheetTab to={to} />}
      {tab === "rekening-koran" && <BankStatementsTab />}
      {tab === "akun" && <AccountsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jurnal tab
// ---------------------------------------------------------------------------

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
  notes: string | null;
  created_at: string;
  lines: JournalLine[];
}

function JournalTab({ from, to }: { from: string; to: string }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingJournal, setEditingJournal] = useState<Journal | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteJournal(id: string) {
    setDeleting(true);
    await fetch(`/api/accounting?id=${id}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["accounting"] });
    setDeletingId(null);
    setDeleting(false);
  }

  const { data, isLoading } = useQuery({
    queryKey: ["accounting", from, to, page],
    queryFn: async () => {
      const params = new URLSearchParams({ from, to, page: String(page) });
      const res = await fetch(`/api/accounting?${params}`);
      return (await res.json()) as {
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
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-400">{total} jurnal</p>
        <Button type="button" size="sm" onClick={() => setShowModal(true)}>
          Tambah Jurnal
        </Button>
      </div>

      {showModal && <NewJournalModal onClose={() => setShowModal(false)} />}
      {editingJournal && (
        <EditJournalModal
          journal={editingJournal}
          onClose={() => setEditingJournal(null)}
        />
      )}

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
          const isDeleting = deletingId === j.id;
          const totalDebit = j.lines.reduce((s, l) => s + l.debit, 0);
          return (
            <div
              key={j.id}
              className={`bg-white rounded-xl border overflow-hidden ${isDeleting ? "border-red-200" : "border-gray-100"}`}
            >
              <div className="flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setExpanded(isOpen ? null : j.id)}
                  className="flex-1 flex items-center justify-between px-4 py-3 h-auto text-left min-w-0"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-xs text-gray-400 w-28 shrink-0">
                      {j.reference}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm text-gray-800 truncate">
                        {j.description}
                      </p>
                      <p className="text-xs text-gray-400">
                        {j.date} · {sourceLabel(j.source_type)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-3">
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
                <div className="flex items-center gap-1 px-2 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingJournal(j);
                      setDeletingId(null);
                    }}
                    className="text-gray-400 hover:text-gray-700 px-2"
                    title="Edit jurnal"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-label="Edit"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeletingId(isDeleting ? null : j.id)}
                    className="text-gray-400 hover:text-red-600 px-2"
                    title="Hapus jurnal"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-label="Hapus"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </Button>
                </div>
              </div>

              {isDeleting && (
                <div className="border-t border-red-100 px-4 py-2 bg-red-50 flex items-center justify-between">
                  <span className="text-xs text-red-600">
                    Hapus jurnal ini? Tindakan tidak bisa dibatalkan.
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDeletingId(null)}
                    >
                      Batal
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={deleting}
                      onClick={() => deleteJournal(j.id)}
                      className="bg-red-600 hover:bg-red-700 text-white"
                    >
                      {deleting ? "Menghapus…" : "Ya, Hapus"}
                    </Button>
                  </div>
                </div>
              )}

              {isOpen && (
                <div className="border-t border-gray-100 px-4 py-3">
                  {j.notes && (
                    <p className="text-xs text-gray-500 mb-3 font-mono bg-gray-50 rounded px-2 py-1">
                      {j.notes}
                    </p>
                  )}
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
                        <tr
                          key={`${line.journal_id}-${line.account?.code}`}
                          className="border-t border-gray-50"
                        >
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

// ---------------------------------------------------------------------------
// Buku Besar (general ledger) tab
// ---------------------------------------------------------------------------

interface LedgerRow {
  journalId: string;
  reference: string;
  description: string;
  date: string;
  debit: number;
  credit: number;
  balance: number;
  // Every line of the journal this row belongs to, this account's own
  // included. A ledger row is half a journal entry; the other half is the
  // only thing that says whether the posting was right.
  entries: { code: string; name: string; debit: number; credit: number }[];
}

function LedgerTab({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const account = params.get("account") ?? "";
  const [openRow, setOpenRow] = useState<string | null>(null);
  const setAccount = (code: string) => {
    const next = new URLSearchParams(params.toString());
    if (code) next.set("account", code);
    else next.delete("account");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const { data: accountsData } = useQuery({
    queryKey: ["accounting-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/accounts");
      return (await res.json()) as { ok: boolean; data: Account[] };
    },
  });
  const accounts = accountsData?.data ?? [];

  // A failed request used to be indistinguishable from a slow one: the tab
  // rendered "Memuat..." while the query was pending and nothing at all once
  // it had failed, so a 500 read as an eternal spinner. Fail loudly instead.
  const { data, isLoading, error } = useQuery({
    enabled: account.length > 0,
    queryKey: ["accounting-ledger", account, from, to],
    queryFn: async () => {
      const params = new URLSearchParams({ account, from, to });
      const res = await fetch(`/api/accounting/ledger?${params}`);
      const json = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        data: {
          account: { code: string; name: string; type: string };
          opening: number;
          rows: LedgerRow[];
          closing: number;
        };
      } | null;
      if (!json) throw new Error(`Server balas ${res.status} tanpa JSON`);
      if (!json.ok) throw new Error(json.error ?? `Gagal memuat (${res.status})`);
      return json;
    },
  });

  return (
    <div>
      <div className="mb-4 max-w-md">
        <Label className="block text-xs text-gray-500 mb-1">Akun</Label>
        <select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Pilih akun…</option>
          {accounts.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </div>

      {!account && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
          Pilih akun untuk melihat buku besar.
        </div>
      )}

      {account && isLoading && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
          Memuat...
        </div>
      )}

      {account && error && (
        <div className="bg-white rounded-xl border border-red-100 p-8 text-center text-red-600 text-sm">
          {error.message}
        </div>
      )}

      {account && data?.ok && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100">
                <th className="text-left p-3 font-normal w-24">Tanggal</th>
                <th className="text-left p-3 font-normal w-28">Ref</th>
                <th className="text-left p-3 font-normal">Keterangan</th>
                <th className="text-right p-3 font-normal w-28">Debit</th>
                <th className="text-right p-3 font-normal w-28">Kredit</th>
                <th className="text-right p-3 font-normal w-32">Saldo</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-50 text-gray-400">
                <td className="p-3" colSpan={5}>
                  Saldo awal
                </td>
                <td className="p-3 text-right font-medium">
                  {formatRp(data.data.opening)}
                </td>
              </tr>
              {data.data.rows.map((r, i) => {
                const rowKey = `${r.journalId}-${i}`;
                const isOpen = openRow === rowKey;
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className={`border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${
                        isOpen ? "bg-gray-50" : ""
                      }`}
                      onClick={() => setOpenRow(isOpen ? null : rowKey)}
                    >
                      <td className="p-3 text-gray-500">{r.date}</td>
                      <td className="p-3 font-mono text-gray-400">
                        {r.reference}
                      </td>
                      <td className="p-3 text-gray-700">{r.description}</td>
                      <td className="p-3 text-right text-gray-700">
                        {r.debit > 0 ? formatRp(r.debit) : "—"}
                      </td>
                      <td className="p-3 text-right text-gray-700">
                        {r.credit > 0 ? formatRp(r.credit) : "—"}
                      </td>
                      <td className="p-3 text-right text-gray-700">
                        {formatRp(r.balance)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <td colSpan={6} className="px-3 pb-3">
                          <table className="w-full">
                            <tbody>
                              {r.entries.map((e) => (
                                <tr key={`${rowKey}-${e.code}-${e.debit}-${e.credit}`}>
                                  <td className="py-1 pl-3 text-gray-500 w-64">
                                    <span className="font-mono">{e.code}</span>{" "}
                                    {e.name}
                                  </td>
                                  <td className="py-1 text-right text-gray-700 w-28">
                                    {e.debit > 0 ? formatRp(e.debit) : ""}
                                  </td>
                                  <td className="py-1 text-right text-gray-700 w-28">
                                    {e.credit > 0 ? formatRp(e.credit) : ""}
                                  </td>
                                  <td />
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {data.data.rows.length === 0 && (
                <tr>
                  <td className="p-3 text-gray-400 text-center" colSpan={6}>
                    Tidak ada transaksi pada periode ini.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-200 font-medium text-gray-800">
                <td className="p-3" colSpan={5}>
                  Saldo akhir
                </td>
                <td className="p-3 text-right">
                  {formatRp(data.data.closing)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Neraca Saldo (trial balance) tab
// ---------------------------------------------------------------------------

function TrialBalanceTab({ from, to }: { from: string; to: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["accounting-trial-balance", from, to],
    queryFn: async () => {
      const params = new URLSearchParams({ type: "trial_balance", from, to });
      const res = await fetch(`/api/accounting/reports?${params}`);
      return (await res.json()) as {
        ok: boolean;
        data: {
          rows: {
            code: string;
            name: string;
            type: string;
            debit: number;
            credit: number;
          }[];
          totalDebit: number;
          totalCredit: number;
        };
      };
    },
  });

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
        Memuat...
      </div>
    );
  }
  if (!data?.ok) return null;

  const { rows, totalDebit, totalCredit } = data.data;
  const balanced = totalDebit === totalCredit;

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 border-b border-gray-100">
            <th className="text-left p-3 font-normal w-16">Kode</th>
            <th className="text-left p-3 font-normal">Akun</th>
            <th className="text-right p-3 font-normal w-32">Debit</th>
            <th className="text-right p-3 font-normal w-32">Kredit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-b border-gray-50">
              <td className="p-3 font-mono text-gray-400">{r.code}</td>
              <td className="p-3 text-gray-700">{r.name}</td>
              <td className="p-3 text-right text-gray-700">
                {r.debit > 0 ? formatRp(r.debit) : "—"}
              </td>
              <td className="p-3 text-right text-gray-700">
                {r.credit > 0 ? formatRp(r.credit) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200 font-medium text-gray-800">
            <td className="p-3" colSpan={2}>
              Total {balanced ? "" : "(tidak seimbang!)"}
            </td>
            <td className={`p-3 text-right ${balanced ? "" : "text-red-600"}`}>
              {formatRp(totalDebit)}
            </td>
            <td className={`p-3 text-right ${balanced ? "" : "text-red-600"}`}>
              {formatRp(totalCredit)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Laba Rugi (P&L) tab
// ---------------------------------------------------------------------------

function PnlTab({ from, to }: { from: string; to: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["accounting-pnl", from, to],
    queryFn: async () => {
      const params = new URLSearchParams({ type: "pnl", from, to });
      const res = await fetch(`/api/accounting/reports?${params}`);
      return (await res.json()) as {
        ok: boolean;
        data: {
          revenue: { code: string; name: string; amount: number }[];
          expense: { code: string; name: string; amount: number }[];
          totalRevenue: number;
          totalExpense: number;
          netIncome: number;
        };
      };
    },
  });

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
        Memuat...
      </div>
    );
  }
  if (!data?.ok) return null;

  const { revenue, expense, totalRevenue, totalExpense, netIncome } = data.data;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 max-w-xl">
      <ReportSection title="Pendapatan" rows={revenue} total={totalRevenue} />
      <ReportSection title="Beban" rows={expense} total={totalExpense} />
      <div className="flex justify-between items-center border-t-2 border-gray-300 pt-3 mt-3">
        <span className="text-sm font-semibold text-gray-900">Laba Bersih</span>
        <span
          className={`text-sm font-semibold ${netIncome >= 0 ? "text-green-600" : "text-red-600"}`}
        >
          {formatRp(netIncome)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Neraca (balance sheet) tab
// ---------------------------------------------------------------------------

function BalanceSheetTab({ to }: { to: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["accounting-balance-sheet", to],
    queryFn: async () => {
      const params = new URLSearchParams({ type: "balance_sheet", to });
      const res = await fetch(`/api/accounting/reports?${params}`);
      return (await res.json()) as {
        ok: boolean;
        data: {
          assets: { code: string; name: string; amount: number }[];
          liabilities: { code: string; name: string; amount: number }[];
          equity: { code: string; name: string; amount: number }[];
          totalAssets: number;
          totalLiabilities: number;
          totalEquity: number;
          balanced: boolean;
        };
      };
    },
  });

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
        Memuat...
      </div>
    );
  }
  if (!data?.ok) return null;

  const {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced,
  } = data.data;

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <ReportSection title="Aset" rows={assets} total={totalAssets} />
      </div>
      <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
        <ReportSection
          title="Liabilitas"
          rows={liabilities}
          total={totalLiabilities}
        />
        <ReportSection title="Ekuitas" rows={equity} total={totalEquity} />
        <div className="flex justify-between items-center border-t-2 border-gray-300 pt-3">
          <span className="text-sm font-semibold text-gray-900">
            Total Liabilitas + Ekuitas
          </span>
          <span
            className={`text-sm font-semibold ${balanced ? "text-gray-900" : "text-red-600"}`}
          >
            {formatRp(totalLiabilities + totalEquity)}
          </span>
        </div>
        {!balanced && (
          <p className="text-xs text-red-600">
            Tidak seimbang dengan total aset.
          </p>
        )}
      </div>
    </div>
  );
}

function ReportSection({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { code: string; name: string; amount: number }[];
  total: number;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
        {title}
      </h3>
      <table className="w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td className="py-1 text-gray-400 font-mono w-12">{r.code}</td>
              <td className="py-1 text-gray-700">{r.name}</td>
              <td className="py-1 text-right text-gray-700">
                {formatRp(r.amount)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="py-1 text-gray-300" colSpan={3}>
                —
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200 font-medium text-gray-800">
            <td className="pt-2" colSpan={2}>
              Total {title}
            </td>
            <td className="pt-2 text-right">{formatRp(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Akun (chart of accounts) tab
// ---------------------------------------------------------------------------

function AccountsTab() {
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["accounting-accounts-all"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/accounts?all=true");
      return (await res.json()) as { ok: boolean; data: ManagedAccount[] };
    },
  });
  const accounts = data?.data ?? [];

  async function toggleActive(a: ManagedAccount) {
    setBusy(a.id);
    await fetch(`/api/accounting/accounts/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !a.is_active }),
    });
    await queryClient.invalidateQueries({
      queryKey: ["accounting-accounts-all"],
    });
    await queryClient.invalidateQueries({ queryKey: ["accounting-accounts"] });
    setBusy(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-400">{accounts.length} akun</p>
        <Button type="button" size="sm" onClick={() => setShowModal(true)}>
          Tambah Akun
        </Button>
      </div>

      {showModal && <NewAccountModal onClose={() => setShowModal(false)} />}

      {isLoading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
          Memuat...
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100">
                <th className="text-left p-3 font-normal w-16">Kode</th>
                <th className="text-left p-3 font-normal">Nama</th>
                <th className="text-left p-3 font-normal w-24">Tipe</th>
                <th className="text-left p-3 font-normal w-40">Kategori</th>
                <th className="text-right p-3 font-normal w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr
                  key={a.id}
                  className={`border-b border-gray-50 ${a.is_active ? "" : "opacity-50"}`}
                >
                  <td className="p-3 font-mono text-gray-400">{a.code}</td>
                  <td className="p-3 text-gray-700">{a.name}</td>
                  <td className="p-3 text-gray-500">{a.type}</td>
                  <td className="p-3 text-gray-500">{a.category}</td>
                  <td className="p-3 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy === a.id}
                      onClick={() => toggleActive(a)}
                      className={
                        a.is_active ? "text-gray-500" : "text-green-600"
                      }
                    >
                      {a.is_active ? "Nonaktifkan" : "Aktifkan"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewAccountModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof ACCOUNT_TYPES)[number]>("Expense");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canSubmit =
    /^\d{3,5}$/.test(code) && name.trim() && category.trim() && !saving;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/accounting/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          type,
          category: category.trim(),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Gagal menyimpan akun");
        setSaving(false);
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: ["accounting-accounts-all"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["accounting-accounts"],
      });
      onClose();
    } catch {
      setError("Gagal terhubung ke server");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl w-full max-w-md my-8 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Akun Baru</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Tutup
          </Button>
        </div>

        <div className="space-y-3">
          <div>
            <Label className="block text-xs text-gray-500 mb-1">
              Kode (3–5 digit)
            </Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6005"
              inputMode="numeric"
            />
          </div>
          <div>
            <Label className="block text-xs text-gray-500 mb-1">Nama</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nama akun"
            />
          </div>
          <div>
            <Label className="block text-xs text-gray-500 mb-1">Tipe</Label>
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as (typeof ACCOUNT_TYPES)[number])
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="block text-xs text-gray-500 mb-1">Kategori</Label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Operating Expenses"
            />
          </div>
        </div>

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {saving ? "Menyimpan…" : "Simpan"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New journal modal (manual entry)
// ---------------------------------------------------------------------------

interface DraftLine {
  accountCode: string;
  debit: string;
  credit: string;
}

function NewJournalModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    { accountCode: "", debit: "", credit: "" },
    { accountCode: "", debit: "", credit: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: accountsData } = useQuery({
    queryKey: ["accounting-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/accounts");
      return (await res.json()) as { ok: boolean; data: Account[] };
    },
  });
  const accounts = accountsData?.data ?? [];

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = totalDebit > 0 && totalDebit === totalCredit;
  const allLinesValid = lines.every(
    (l) => l.accountCode && Number(l.debit) > 0 !== Number(l.credit) > 0,
  );
  const canSubmit =
    balanced && allLinesValid && description.trim().length > 0 && !saving;

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  }

  function addLine() {
    setLines((prev) => [...prev, { accountCode: "", debit: "", credit: "" }]);
  }

  function removeLine(i: number) {
    setLines((prev) =>
      prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev,
    );
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          description: description.trim(),
          lines: lines.map((l) => ({
            accountCode: l.accountCode,
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
          })),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Gagal menyimpan jurnal");
        setSaving(false);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["accounting"] });
      onClose();
    } catch {
      setError("Gagal terhubung ke server");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl w-full max-w-2xl my-8 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Jurnal Manual</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Tutup
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <Label className="block text-xs text-gray-500 mb-1">Tanggal</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label className="block text-xs text-gray-500 mb-1">
              Deskripsi
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Keterangan jurnal"
            />
          </div>
        </div>

        <div className="space-y-2 mb-3">
          <div className="flex gap-2 text-xs text-gray-400 px-1">
            <span className="flex-1">Akun</span>
            <span className="w-28 text-right">Debit</span>
            <span className="w-28 text-right">Kredit</span>
            <span className="w-8" />
          </div>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: line rows are positional
            <div key={i} className="flex gap-2 items-center">
              <select
                value={line.accountCode}
                onChange={(e) => updateLine(i, { accountCode: e.target.value })}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Pilih akun…</option>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                value={line.debit}
                onChange={(e) =>
                  updateLine(i, { debit: e.target.value, credit: "" })
                }
                placeholder="0"
                className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm text-right"
              />
              <input
                type="number"
                min="0"
                value={line.credit}
                onChange={(e) =>
                  updateLine(i, { credit: e.target.value, debit: "" })
                }
                placeholder="0"
                className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm text-right"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeLine(i)}
                disabled={lines.length <= 2}
                className="w-8 px-0 text-gray-400"
              >
                ×
              </Button>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addLine}
          className="mb-4"
        >
          + Baris
        </Button>

        <div className="flex justify-between items-center text-sm border-t border-gray-100 pt-3 mb-4">
          <span className={balanced ? "text-green-600" : "text-gray-400"}>
            {balanced ? "Seimbang" : "Belum seimbang"}
          </span>
          <span className="text-gray-600">
            Debit {formatRp(totalDebit)} · Kredit {formatRp(totalCredit)}
          </span>
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {saving ? "Menyimpan…" : "Simpan"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit journal modal
// ---------------------------------------------------------------------------

function EditJournalModal({
  journal,
  onClose,
}: {
  journal: Journal;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(journal.date);
  const [description, setDescription] = useState(journal.description);
  const [notes, setNotes] = useState(journal.notes ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    journal.lines.map((l) => ({
      accountCode: l.account?.code ?? "",
      debit: l.debit > 0 ? String(l.debit) : "",
      credit: l.credit > 0 ? String(l.credit) : "",
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: accountsData } = useQuery({
    queryKey: ["accounting-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/accounts");
      return (await res.json()) as { ok: boolean; data: Account[] };
    },
  });
  const accounts = accountsData?.data ?? [];

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = totalDebit > 0 && totalDebit === totalCredit;
  const allLinesValid = lines.every(
    (l) => l.accountCode && Number(l.debit) > 0 !== Number(l.credit) > 0,
  );
  const canSubmit =
    balanced && allLinesValid && description.trim().length > 0 && !saving;

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  }

  function addLine() {
    setLines((prev) => [...prev, { accountCode: "", debit: "", credit: "" }]);
  }

  function removeLine(i: number) {
    setLines((prev) =>
      prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev,
    );
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/accounting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: journal.id,
          date,
          description: description.trim(),
          notes: notes.trim() || null,
          lines: lines.map((l) => ({
            accountCode: l.accountCode,
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
          })),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Gagal menyimpan jurnal");
        setSaving(false);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["accounting"] });
      onClose();
    } catch {
      setError("Gagal terhubung ke server");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl w-full max-w-2xl my-8 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Edit Jurnal</h2>
            <p className="text-xs text-gray-400 font-mono">
              {journal.reference}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Tutup
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label className="block text-xs text-gray-500 mb-1">Tanggal</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label className="block text-xs text-gray-500 mb-1">
              Deskripsi
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Keterangan jurnal"
            />
          </div>
        </div>

        <div className="mb-3">
          <Label className="block text-xs text-gray-500 mb-1">
            Catatan perhitungan (opsional)
          </Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="mis. 45p × Rp26.000 = Rp1.170.000"
            rows={2}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono resize-none"
          />
        </div>

        <div className="space-y-2 mb-3">
          <div className="flex gap-2 text-xs text-gray-400 px-1">
            <span className="flex-1">Akun</span>
            <span className="w-28 text-right">Debit</span>
            <span className="w-28 text-right">Kredit</span>
            <span className="w-8" />
          </div>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: line rows are positional
            <div key={i} className="flex gap-2 items-center">
              <select
                value={line.accountCode}
                onChange={(e) => updateLine(i, { accountCode: e.target.value })}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Pilih akun…</option>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                value={line.debit}
                onChange={(e) =>
                  updateLine(i, { debit: e.target.value, credit: "" })
                }
                placeholder="0"
                className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm text-right"
              />
              <input
                type="number"
                min="0"
                value={line.credit}
                onChange={(e) =>
                  updateLine(i, { credit: e.target.value, debit: "" })
                }
                placeholder="0"
                className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm text-right"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeLine(i)}
                disabled={lines.length <= 2}
                className="w-8 px-0 text-gray-400"
              >
                ×
              </Button>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addLine}
          className="mb-4"
        >
          + Baris
        </Button>

        <div className="flex justify-between items-center text-sm border-t border-gray-100 pt-3 mb-4">
          <span className={balanced ? "text-green-600" : "text-gray-400"}>
            {balanced ? "Seimbang" : "Belum seimbang"}
          </span>
          <span className="text-gray-600">
            Debit {formatRp(totalDebit)} · Kredit {formatRp(totalCredit)}
          </span>
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {saving ? "Menyimpan…" : "Simpan Perubahan"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rekening Koran tab
//
// The reconcile view. A bank line has two sides and one of them is already
// known — it is the statement's own account — so the only open question about
// any line is which account the other side faces. This tab is where that
// question gets answered and, more often, where a wrong answer gets caught:
// the summary groups the statement by contra account so a kitchen payment
// filed as a personal drawing shows up as a number in the wrong row.
// ---------------------------------------------------------------------------

interface BankStatement {
  id: string;
  account_code: string;
  account_number: string;
  account_label: string | null;
  currency: string;
  period_start: string;
  period_end: string;
  opening_balance: number | null;
  closing_balance: number | null;
  total_credit: number;
  total_debit: number;
  credit_count: number;
  debit_count: number;
  source: string;
  file_path: string | null;
  line_count: number;
  unclassified_count: number;
}

interface BankTransaction {
  id: string;
  row_index: number;
  txn_date: string;
  txn_time: string | null;
  direction: "CR" | "DB";
  amount: number;
  balance_after: number | null;
  counterparty: string | null;
  description: string;
  contra_account_code: string | null;
  journal_id: string | null;
  matched_by: string | null;
  notes: string | null;
}

function monthLabel(start: string, end: string) {
  const d = new Date(`${start}T00:00:00`);
  const same = start.slice(0, 7) === end.slice(0, 7);
  const m = d.toLocaleDateString("id-ID", { month: "long", year: "numeric" });
  return same ? m : `${start} → ${end}`;
}

function BankStatementsTab() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("statement");
  const setSelected = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("statement", id);
    else next.delete("statement");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const [filter, setFilter] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ["accounting-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/accounts");
      return (await res.json()) as { ok: boolean; data: Account[] };
    },
  });
  const accounts = accountsData?.data ?? [];
  const accountName = (code: string | null) =>
    code ? (accounts.find((a) => a.code === code)?.name ?? code) : "Belum ditentukan";

  const statements = useQuery({
    queryKey: ["bank-statements"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/bank");
      const json = (await res.json()) as {
        ok: boolean;
        data?: BankStatement[];
        error?: string;
      };
      if (!json.ok) throw new Error(json.error ?? "Gagal memuat");
      return json.data ?? [];
    },
  });

  const detail = useQuery({
    enabled: selected !== null,
    queryKey: ["bank-statement", selected],
    queryFn: async () => {
      const res = await fetch(`/api/accounting/bank/${selected}`);
      const json = (await res.json()) as {
        ok: boolean;
        data?: { statement: BankStatement; lines: BankTransaction[] };
        error?: string;
      };
      if (!json.ok) throw new Error(json.error ?? "Gagal memuat");
      return json.data;
    },
  });

  async function setAccount(txnId: string, code: string) {
    setSaving(txnId);
    setSaveError(null);
    try {
      const res = await fetch(`/api/accounting/bank/transactions/${txnId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contra_account_code: code || null }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Gagal menyimpan");
      await queryClient.invalidateQueries({ queryKey: ["bank-statement", selected] });
      await queryClient.invalidateQueries({ queryKey: ["bank-statements"] });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Gagal menyimpan");
    } finally {
      setSaving(null);
    }
  }

  if (statements.isLoading)
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
        Memuat...
      </div>
    );

  if (statements.error)
    return (
      <div className="bg-white rounded-xl border border-red-100 p-8 text-center text-red-600 text-sm">
        {statements.error.message}
      </div>
    );

  const list = statements.data ?? [];

  if (list.length === 0)
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
        Belum ada rekening koran. Import dengan{" "}
        <code className="text-gray-600">
          pnpm tsx --env-file=.env.local scripts/import-bank-statements.ts &lt;file.pdf&gt;
        </code>
      </div>
    );

  const lines = detail.data?.lines ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = lines.filter((l) => {
    if (onlyOpen && l.contra_account_code) return false;
    if (!needle) return true;
    return (
      l.description.toLowerCase().includes(needle) ||
      (l.counterparty ?? "").toLowerCase().includes(needle) ||
      (l.contra_account_code ?? "").includes(needle)
    );
  });

  // Grouped by contra account: the answer to "is this in the right account?"
  const groups = new Map<
    string,
    { code: string | null; inCount: number; inSum: number; outCount: number; outSum: number }
  >();
  for (const l of lines) {
    const key = l.contra_account_code ?? "";
    const g =
      groups.get(key) ??
      { code: l.contra_account_code, inCount: 0, inSum: 0, outCount: 0, outSum: 0 };
    if (l.direction === "CR") {
      g.inCount++;
      g.inSum += Number(l.amount);
    } else {
      g.outCount++;
      g.outSum += Number(l.amount);
    }
    groups.set(key, g);
  }
  const grouped = [...groups.values()].sort((a, b) =>
    (a.code ?? "zzzz").localeCompare(b.code ?? "zzzz"),
  );

  return (
    <div>
      {/* Statement picker */}
      <div className="grid gap-2 mb-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((s) => {
          const active = s.id === selected;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(active ? null : s.id)}
              className={`text-left rounded-xl border p-3 transition-colors ${
                active
                  ? "border-gray-900 bg-white"
                  : "border-gray-100 bg-white hover:border-gray-300"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-gray-900">
                  {s.account_code} — {accountName(s.account_code)}
                </span>
                <span className="text-xs text-gray-400">{s.currency}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {monthLabel(s.period_start, s.period_end)} · {s.account_number}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                Masuk {formatRp(Math.round(Number(s.total_credit)))} · Keluar{" "}
                {formatRp(Math.round(Number(s.total_debit)))}
              </div>
              <div className="text-xs mt-1">
                <span className="text-gray-400">{s.line_count} transaksi</span>
                {s.unclassified_count > 0 && (
                  <span className="text-amber-600 ml-2">
                    {s.unclassified_count} belum berakun
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {!selected && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
          Pilih rekening koran untuk memeriksa akunnya.
        </div>
      )}

      {selected && detail.isLoading && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400 text-sm">
          Memuat...
        </div>
      )}

      {selected && detail.error && (
        <div className="bg-white rounded-xl border border-red-100 p-8 text-center text-red-600 text-sm">
          {detail.error.message}
        </div>
      )}

      {selected && detail.data && (
        <>
          {/* Per-account summary */}
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden mb-4">
            <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500">
              Ringkasan per akun lawan
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-left p-3 font-normal">Akun</th>
                  <th className="text-right p-3 font-normal w-20">Masuk</th>
                  <th className="text-right p-3 font-normal w-32">Nilai</th>
                  <th className="text-right p-3 font-normal w-20">Keluar</th>
                  <th className="text-right p-3 font-normal w-32">Nilai</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => (
                  <tr
                    key={g.code ?? "none"}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="p-3">
                      <span
                        className={
                          g.code ? "text-gray-900" : "text-amber-600 font-medium"
                        }
                      >
                        {g.code ? `${g.code} — ${accountName(g.code)}` : "Belum berakun"}
                      </span>
                    </td>
                    <td className="p-3 text-right text-gray-400">
                      {g.inCount || ""}
                    </td>
                    <td className="p-3 text-right text-gray-700">
                      {g.inSum ? formatRp(Math.round(g.inSum)) : ""}
                    </td>
                    <td className="p-3 text-right text-gray-400">
                      {g.outCount || ""}
                    </td>
                    <td className="p-3 text-right text-gray-700">
                      {g.outSum ? formatRp(Math.round(g.outSum)) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Line filter */}
          <div className="flex flex-wrap gap-3 items-end mb-3">
            <div className="flex-1 min-w-48">
              <Label className="block text-xs text-gray-500 mb-1">Cari</Label>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Nama, keterangan, kode akun…"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-600 pb-2">
              <input
                type="checkbox"
                checked={onlyOpen}
                onChange={(e) => setOnlyOpen(e.target.checked)}
              />
              Hanya yang belum berakun
            </label>
            <span className="text-xs text-gray-400 pb-2">
              {shown.length} dari {lines.length}
            </span>
          </div>

          {saveError && <p className="text-sm text-red-600 mb-2">{saveError}</p>}

          <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-left p-3 font-normal w-24">Tanggal</th>
                  <th className="text-left p-3 font-normal">Keterangan</th>
                  <th className="text-right p-3 font-normal w-28">Masuk</th>
                  <th className="text-right p-3 font-normal w-28">Keluar</th>
                  <th className="text-left p-3 font-normal w-64">Akun lawan</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <tr key={l.id} className="border-b border-gray-50 last:border-0">
                    <td className="p-3 text-gray-500 whitespace-nowrap align-top">
                      {l.txn_date.slice(5)}
                      {l.txn_time && (
                        <span className="block text-gray-300">{l.txn_time}</span>
                      )}
                    </td>
                    <td className="p-3 align-top">
                      <span className="text-gray-900">
                        {l.counterparty ?? l.description}
                      </span>
                      {l.counterparty && (
                        <span className="block text-gray-400">{l.description}</span>
                      )}
                    </td>
                    <td className="p-3 text-right align-top text-gray-700">
                      {l.direction === "CR"
                        ? formatRp(Math.round(Number(l.amount)))
                        : ""}
                    </td>
                    <td className="p-3 text-right align-top text-gray-700">
                      {l.direction === "DB"
                        ? formatRp(Math.round(Number(l.amount)))
                        : ""}
                    </td>
                    <td className="p-3 align-top">
                      <select
                        value={l.contra_account_code ?? ""}
                        disabled={saving === l.id}
                        onChange={(e) => setAccount(l.id, e.target.value)}
                        className={`w-full border rounded-lg px-2 py-1 text-xs ${
                          l.contra_account_code
                            ? "border-gray-200 text-gray-900"
                            : "border-amber-300 text-amber-700"
                        }`}
                      >
                        <option value="">Belum ditentukan</option>
                        {accounts.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                      </select>
                      {l.matched_by && (
                        <span className="block text-gray-300 mt-1">
                          diubah manual
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
