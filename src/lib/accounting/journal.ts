import { createAdminClient } from "@/lib/supabase/admin";

interface JournalLine {
  accountCode: string;
  debit: number;
  credit: number;
}

interface CreateJournalOptions {
  description: string;
  date: string; // YYYY-MM-DD
  sourceType:
    | "order_payment"
    | "delivery"
    | "delivery_cogs"
    | "delivery_ongkir"
    // A refund reverses the payment journal. Keyed on the order, so an order
    // can only be refunded into the books once.
    | "refund"
    // Money that actually left the bank, journalised from the statement line
    // that is its evidence. Keyed on the bank_transactions row, so one line
    // can only be posted once however many times the button is pressed.
    | "bank_settlement"
    // A kitchen paid today, entered by hand because the statement that proves
    // it does not exist until next month. Keyed on a generated id — there is
    // no document to key it on yet, which is the whole reason it exists — so
    // the guard against a second one is the human, and the guard against the
    // statement double-posting it is `settleBankLines`, which links the line
    // to this journal instead of writing another.
    | "kitchen_payment";
  sourceId: string;
  notes?: string;
  lines: JournalLine[];
}

// The journal already posted for this source, if there is one (idempotency
// guard). Returns its id rather than a boolean because a caller that holds the
// evidence — a bank line — needs to point at the journal even when an earlier
// press of the same button is what created it.
async function existingJournalId(
  sourceType: string,
  sourceId: string,
): Promise<string | null> {
  const db = createAdminClient();
  const { data } = await db
    .from("journals")
    .select("id")
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Posts one balanced journal, once per (sourceType, sourceId).
 *
 * Returns the journal id and whether this call is what wrote it — a caller
 * re-walking a settled period needs to tell "posted Rp 2jt" from "Rp 2jt was
 * already posted", and a caller holding the evidence needs the id either way.
 * Null means nothing could be posted. It deliberately does not throw: every
 * caller posts *after* the business write has landed, and failing their
 * request over bookkeeping would undo nothing.
 */
export async function createJournalEntry(
  opts: CreateJournalOptions,
): Promise<{ id: string; created: boolean } | null> {
  const already = await existingJournalId(opts.sourceType, opts.sourceId);
  if (already) return { id: already, created: false };

  const db = createAdminClient();

  // Resolve account codes → IDs in one query
  const codes = opts.lines.map((l) => l.accountCode);
  const { data: accounts, error: acctErr } = await db
    .from("accounts")
    .select("id, code")
    .in("code", codes);

  if (acctErr || !accounts?.length) {
    console.error("[accounting] failed to resolve accounts:", acctErr?.message);
    return null;
  }

  const codeToId = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

  // Validate all codes resolved
  for (const code of codes) {
    if (!codeToId[code]) {
      console.error("[accounting] unknown account code:", code);
      return null;
    }
  }

  // Generate reference atomically
  const year = new Date(opts.date).getFullYear();
  const { data: ref, error: refErr } = await db.rpc("next_journal_reference", {
    p_year: year,
  });
  if (refErr || !ref) {
    console.error(
      "[accounting] failed to generate reference:",
      refErr?.message,
    );
    return null;
  }

  const { data: journal, error: journalErr } = await db
    .from("journals")
    .insert({
      reference: ref as string,
      description: opts.description,
      date: opts.date,
      source_type: opts.sourceType,
      source_id: opts.sourceId,
      notes: opts.notes ?? null,
    })
    .select("id")
    .single();

  if (journalErr || !journal) {
    console.error(
      "[accounting] failed to insert journal:",
      journalErr?.message,
    );
    return null;
  }

  const { error: linesErr } = await db.from("journal_lines").insert(
    opts.lines.map((l) => ({
      journal_id: journal.id,
      account_id: codeToId[l.accountCode],
      debit: l.debit,
      credit: l.credit,
    })),
  );

  if (linesErr) {
    console.error(
      "[accounting] failed to insert journal lines:",
      linesErr.message,
    );
    // Clean up orphaned header
    await db.from("journals").delete().eq("id", journal.id);
    return null;
  }

  return { id: journal.id, created: true };
}
