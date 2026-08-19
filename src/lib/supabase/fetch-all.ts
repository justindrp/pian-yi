/**
 * Walk a Supabase select to completion.
 *
 * An unpaginated select caps at 1000 rows and gives no signal when it
 * truncates, so anything that must be complete has to be walked with
 * `.range()`. This project has been bitten by it repeatedly — orders capped at
 * 100 of 432 (twice), the inbox capped at 500, and `query_leads` returning only
 * the oldest conversations, which made its newest leads look unreachable.
 *
 * Pass a callback that applies `.range(from, to)` to an otherwise finished
 * query builder. Works with the browser client and the admin client alike.
 */
export async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error?: string }> {
  const SIZE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) return { rows, error: error.message };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < SIZE) break;
  }
  return { rows };
}
