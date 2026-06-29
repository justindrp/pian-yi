import { checkRateLimit } from "@/lib/claude/safety";
import { createAdminClient } from "@/lib/supabase/admin";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/push/send", () => ({ sendPushToAllAdmins: jest.fn() }));

function makeChain(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "eq",
    "neq",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "in",
    "limit",
    "order",
    "is",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) {
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    }
    return chains[table];
  });
  return { from, chains };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("checkRateLimit", () => {
  test("allows VIP customers without checking usage counters", async () => {
    const db = makeDbMock({
      customer_flags: { data: { vip_status: true }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const result = await checkRateLimit("cust-1");

    expect(result).toEqual({ allowed: true });
    expect(db.from).toHaveBeenCalledWith("customer_flags");
    expect(db.from).not.toHaveBeenCalledWith("customer_rate_limits");
  });

  test("still blocks non-VIP customers who hit the token cap", async () => {
    const db = makeDbMock({
      customer_flags: { data: { vip_status: false }, error: null },
      customer_rate_limits: {
        data: {
          daily_message_count: 0,
          daily_token_count: 200_000,
          minute_message_count: 0,
          last_message_at: new Date().toISOString(),
          last_reset_at: new Date().toISOString(),
        },
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const result = await checkRateLimit("cust-1");

    expect(result).toEqual({ allowed: false, reason: "token_limit" });
  });
});
