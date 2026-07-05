import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/pipeline-stage/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

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
    if (!chains[table])
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/pipeline-stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: "u1", email: "admin@example.com" } },
      }),
    },
  });
});

describe("POST /api/inbox/pipeline-stage", () => {
  test("T1 — updates customer_state only for slim states", async () => {
    const db = makeDbMock({
      customers: { data: { id: "cust-1" }, error: null },
      customer_state: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", stage: "ordering" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(db.chains.customer_state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        state: "ordering",
      }),
      expect.objectContaining({ onConflict: "customer_id" }),
    );
    expect(db.from).not.toHaveBeenCalledWith("orders");
  });

  test("T2 — browsing alias is normalized to new", async () => {
    const db = makeDbMock({
      customers: { data: { id: "cust-1" }, error: null },
      customer_state: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", stage: "browsing" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stage).toBe("new");
    expect(db.chains.customer_state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        state: "new",
      }),
      expect.objectContaining({ onConflict: "customer_id" }),
    );
  });
});
