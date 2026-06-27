import { NextRequest } from "next/server";
import { GET as reportsGET } from "@/app/api/accounting/reports/route";
import { GET as ledgerGET } from "@/app/api/accounting/ledger/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/get-role", () => ({
  getSessionWithRole: jest.fn(),
  isOwner: (role: string) => role === "owner",
}));

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "in", "order", "gte", "lte", "lt", "limit"];
  for (const m of methods) chain[m] = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeDbMock(config: Record<string, { data: unknown; error: unknown }>) {
  const from = jest.fn((table: string) => makeChain(config[table] ?? { data: null, error: null }));
  return { from };
}

// Asset 1002 debit 50000, Revenue 4001 credit 50000.
const LINES = [
  {
    debit: 50000,
    credit: 0,
    account: { code: "1002", name: "Bank BCA", type: "Asset", normal_balance: "Debit" },
    journals: { date: "2026-06-10" },
  },
  {
    debit: 0,
    credit: 50000,
    account: { code: "4001", name: "Catering Revenue", type: "Revenue", normal_balance: "Credit" },
    journals: { date: "2026-06-10" },
  },
];

function reportReq(type: string) {
  return new NextRequest(`http://localhost/api/accounting/reports?type=${type}&from=2026-06-01&to=2026-06-30`);
}

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "drpramadyo@gmail.com", role: "owner" });
});

describe("GET /api/accounting/reports", () => {
  test("non-owner returns 403", async () => {
    (getSessionWithRole as jest.Mock).mockResolvedValue({ email: "a@x.com", role: "admin" });
    const res = await reportsGET(reportReq("trial_balance"));
    expect(res.status).toBe(403);
  });

  test("invalid type returns 400", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(makeDbMock({}));
    const res = await reportsGET(reportReq("nope"));
    expect(res.status).toBe(400);
  });

  test("trial_balance nets each account onto its normal side and balances", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ journal_lines: { data: LINES, error: null } }),
    );
    const res = await reportsGET(reportReq("trial_balance"));
    const json = await res.json();
    expect(json.data.totalDebit).toBe(50000);
    expect(json.data.totalCredit).toBe(50000);
    const bank = json.data.rows.find((r: { code: string }) => r.code === "1002");
    expect(bank.debit).toBe(50000);
    expect(bank.credit).toBe(0);
  });

  test("pnl computes net income from revenue minus expense", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ journal_lines: { data: LINES, error: null } }),
    );
    const res = await reportsGET(reportReq("pnl"));
    const json = await res.json();
    expect(json.data.totalRevenue).toBe(50000);
    expect(json.data.totalExpense).toBe(0);
    expect(json.data.netIncome).toBe(50000);
  });

  test("balance_sheet folds earnings into equity and balances", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ journal_lines: { data: LINES, error: null } }),
    );
    const res = await reportsGET(reportReq("balance_sheet"));
    const json = await res.json();
    expect(json.data.totalAssets).toBe(50000);
    expect(json.data.totalLiabilities).toBe(0);
    expect(json.data.totalEquity).toBe(50000); // retained earnings line
    expect(json.data.balanced).toBe(true);
  });
});

describe("GET /api/accounting/ledger", () => {
  test("missing account returns 400", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(makeDbMock({}));
    const res = await ledgerGET(new NextRequest("http://localhost/api/accounting/ledger?to=2026-06-30"));
    expect(res.status).toBe(400);
  });

  test("unknown account returns 404", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(makeDbMock({ accounts: { data: null, error: null } }));
    const res = await ledgerGET(
      new NextRequest("http://localhost/api/accounting/ledger?account=9999&to=2026-06-30"),
    );
    expect(res.status).toBe(404);
  });

  test("computes running balance on the normal side", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({
        accounts: {
          data: { id: "a1", code: "1002", name: "Bank BCA", type: "Asset", normal_balance: "Debit" },
          error: null,
        },
        journal_lines: {
          data: [
            { debit: 50000, credit: 0, journals: { reference: "JV-2026-001", description: "in", date: "2026-06-10" } },
            { debit: 0, credit: 20000, journals: { reference: "JV-2026-002", description: "out", date: "2026-06-12" } },
          ],
          error: null,
        },
      }),
    );
    const res = await ledgerGET(
      new NextRequest("http://localhost/api/accounting/ledger?account=1002&to=2026-06-30"),
    );
    const json = await res.json();
    expect(json.data.opening).toBe(0);
    expect(json.data.rows[0].balance).toBe(50000);
    expect(json.data.rows[1].balance).toBe(30000);
    expect(json.data.closing).toBe(30000);
  });
});
