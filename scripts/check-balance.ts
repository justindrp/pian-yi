/**
 * Prints the model account's remaining balance, and exits non-zero when it is
 * low enough to strand the bot.
 *
 *   pnpm check-balance            warn below $2
 *   pnpm check-balance 5          warn below $5
 *
 * Exit codes: 0 healthy, 1 low or empty, 2 could not read the balance.
 *
 * DeepSeek has no auto-debit — top-ups are prepaid and manual, so the balance
 * reaches zero on its own schedule and the bot goes silent with it. It has
 * happened three times: 24 August (two hours, four customers unanswered),
 * 5-6 September (overnight, two ad leads welcomed and then abandoned) and
 * 16 September (12:13 WIB, still down a day later). Nothing watched the number.
 *
 * The endpoint is derived from ANTHROPIC_BASE_URL, so pointing the app at a
 * different provider makes this fail loudly rather than keep reporting a
 * balance nobody is spending any more.
 */
const DEFAULT_LOW_USD = 2;

type BalanceResponse = {
  is_available: boolean;
  balance_infos: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
};

async function main() {
  const lowUsd = Number(process.argv[2] ?? DEFAULT_LOW_USD);
  const key = process.env.ANTHROPIC_API_KEY;
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!key || !base) {
    console.error("ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL must both be set");
    process.exit(2);
  }

  const url = `${new URL(base).origin}/user/balance`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`balance check failed: ${res.status} ${res.statusText}`);
    process.exit(2);
  }

  const body = (await res.json()) as BalanceResponse;
  const usd = body.balance_infos.find((b) => b.currency === "USD");
  if (!usd) {
    console.error("no USD balance on the account");
    process.exit(2);
  }

  const total = Number(usd.total_balance);
  console.log(
    `balance $${total.toFixed(2)} (granted $${usd.granted_balance}, topped up $${usd.topped_up_balance})`,
  );

  if (!body.is_available || total <= 0) {
    console.error(
      "EMPTY — every model call returns 402, the bot is answering nobody",
    );
    process.exit(1);
  }
  if (total < lowUsd) {
    console.error(`LOW — under $${lowUsd}, top up before it strands the bot`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
