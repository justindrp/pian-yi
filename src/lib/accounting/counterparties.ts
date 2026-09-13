import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Who the counterparties on a bank statement are.
 *
 * The statements name individuals, and the line itself never says which of them
 * is a kitchen owner, a rice supplier or Justin buying bubble tea. That map used
 * to live in four places — a hardcoded array in `statement-parser.ts`, a prose
 * table in `docs/OPERATIONS.md`, a const in `scripts/reattribute-kitchens.ts`,
 * and the rest only ever in chat — so a pass that consulted none of them asked
 * the owner to identify people he had already identified. It lives in
 * `bank_counterparties` now; this reads it.
 *
 * Not cached. A classification run reads it once and a statement import happens
 * a few times a month, so a stale identity costs more than the query does.
 */

export type CounterpartyRule = {
  re: RegExp;
  label: string;
  kind: string;
  contraAccountCode: string | null;
  subcontractorId: string | null;
  bankAccountCode: string | null;
};

export async function loadCounterpartyRules(
  db: SupabaseClient<Database>,
): Promise<CounterpartyRule[]> {
  const { data, error } = await db
    .from("bank_counterparties")
    .select(
      "pattern, label, kind, contra_account_code, subcontractor_id, bank_account_code, priority",
    )
    .eq("is_active", true)
    .order("priority", { ascending: true });
  if (error) throw new Error(`bank_counterparties: ${error.message}`);

  return (data ?? [])
    // A pattern the database accepts can still be a regex JavaScript refuses;
    // one bad row must not take the whole import down, so it is dropped loudly.
    .flatMap((r) => {
      try {
        return [
          {
            re: new RegExp(r.pattern, "i"),
            label: r.label,
            kind: r.kind,
            contraAccountCode: r.contra_account_code,
            subcontractorId: r.subcontractor_id,
            bankAccountCode: r.bank_account_code,
          },
        ];
      } catch {
        console.error(`[counterparties] unusable pattern: ${r.pattern}`);
        return [];
      }
    });
}

/** The first rule whose pattern is in the text, honouring a bank restriction. */
export function matchCounterparty(
  rules: CounterpartyRule[],
  text: string,
  bankAccountCode: string,
): CounterpartyRule | null {
  for (const r of rules) {
    if (r.bankAccountCode && r.bankAccountCode !== bankAccountCode) continue;
    if (r.re.test(text)) return r;
  }
  return null;
}
