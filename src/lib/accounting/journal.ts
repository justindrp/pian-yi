import { createAdminClient } from "@/lib/supabase/admin";

interface JournalLine {
  accountCode: string;
  debit: number;
  credit: number;
}

interface CreateJournalOptions {
  description: string;
  date: string; // YYYY-MM-DD
  sourceType: "order_payment" | "delivery" | "delivery_cogs";
  sourceId: string;
  lines: JournalLine[];
}

// Returns true if a journal already exists for this source (idempotency guard)
async function journalExists(sourceType: string, sourceId: string): Promise<boolean> {
  const db = createAdminClient();
  const { data } = await db
    .from("journals")
    .select("id")
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .maybeSingle();
  return data !== null;
}

export async function createJournalEntry(opts: CreateJournalOptions): Promise<void> {
  if (await journalExists(opts.sourceType, opts.sourceId)) return;

  const db = createAdminClient();

  // Resolve account codes → IDs in one query
  const codes = opts.lines.map((l) => l.accountCode);
  const { data: accounts, error: acctErr } = await db
    .from("accounts")
    .select("id, code")
    .in("code", codes);

  if (acctErr || !accounts?.length) {
    console.error("[accounting] failed to resolve accounts:", acctErr?.message);
    return;
  }

  const codeToId = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

  // Validate all codes resolved
  for (const code of codes) {
    if (!codeToId[code]) {
      console.error("[accounting] unknown account code:", code);
      return;
    }
  }

  // Generate reference atomically
  const year = new Date(opts.date).getFullYear();
  const { data: ref, error: refErr } = await db.rpc("next_journal_reference", { p_year: year });
  if (refErr || !ref) {
    console.error("[accounting] failed to generate reference:", refErr?.message);
    return;
  }

  const { data: journal, error: journalErr } = await db
    .from("journals")
    .insert({
      reference: ref as string,
      description: opts.description,
      date: opts.date,
      source_type: opts.sourceType,
      source_id: opts.sourceId,
    })
    .select("id")
    .single();

  if (journalErr || !journal) {
    console.error("[accounting] failed to insert journal:", journalErr?.message);
    return;
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
    console.error("[accounting] failed to insert journal lines:", linesErr.message);
    // Clean up orphaned header
    await db.from("journals").delete().eq("id", journal.id);
  }
}
