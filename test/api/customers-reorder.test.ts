import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/customers/reorder/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));

const CUST_1 = "11111111-1111-4111-8111-111111111111";
const CUST_2 = "22222222-2222-4222-8222-222222222222";

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "maybeSingle", "in", "not", "update"]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  results: Record<string, { data: unknown; error: unknown }[]>,
) {
  const chains: Record<string, Chain[]> = {};
  const from = jest.fn((table: string) => {
    const tableResults = results[table] ?? [{ data: null, error: null }];
    const index = chains[table]?.length ?? 0;
    const chain = makeChain(
      tableResults[Math.min(index, tableResults.length - 1)],
    );
    chains[table] = [...(chains[table] ?? []), chain];
    return chain;
  });
  return { from, chains };
}

function mockUser(email: string | null) {
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: email ? { email } : null },
      }),
    },
  });
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/customers/reorder", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PATCH /api/customers/reorder", () => {
  test("returns 401 when unauthenticated", async () => {
    mockUser(null);

    const res = await PATCH(request({ updates: [] }));

    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  test("returns 403 when user is not an admin", async () => {
    mockUser("not-admin@example.com");
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({ admin_users: [{ data: null, error: null }] }),
    );

    const res = await PATCH(request({ updates: [] }));

    expect(res.status).toBe(403);
  });

  test("rejects invalid update payload", async () => {
    mockUser("admin@example.com");
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({
        admin_users: [{ data: { email: "admin@example.com" }, error: null }],
      }),
    );

    const res = await PATCH(
      request({ updates: [{ id: CUST_1, delivery_position: -1 }] }),
    );

    expect(res.status).toBe(400);
  });

  test("updates routed customers and checks update errors", async () => {
    mockUser("admin@example.com");
    const db = makeDbMock({
      admin_users: [{ data: { email: "admin@example.com" }, error: null }],
      customers: [
        { data: [{ id: CUST_1 }, { id: CUST_2 }], error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(
      request({
        updates: [
          { id: CUST_1, delivery_position: 0 },
          { id: CUST_2, delivery_position: 1 },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(db.from).toHaveBeenCalledWith("customers");
    expect(db.chains.customers[1].update).toHaveBeenCalledWith({
      delivery_position: 0,
    });
    expect(db.chains.customers[2].update).toHaveBeenCalledWith({
      delivery_position: 1,
    });
  });

  test("rejects customers that are not routed", async () => {
    mockUser("admin@example.com");
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({
        admin_users: [{ data: { email: "admin@example.com" }, error: null }],
        customers: [{ data: [{ id: CUST_1 }], error: null }],
      }),
    );

    const res = await PATCH(
      request({
        updates: [
          { id: CUST_1, delivery_position: 0 },
          { id: CUST_2, delivery_position: 1 },
        ],
      }),
    );

    expect(res.status).toBe(400);
  });

  test("returns 500 when an update fails", async () => {
    mockUser("admin@example.com");
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDbMock({
        admin_users: [{ data: { email: "admin@example.com" }, error: null }],
        customers: [
          { data: [{ id: CUST_1 }], error: null },
          { data: null, error: { message: "update failed" } },
        ],
      }),
    );

    const res = await PATCH(
      request({ updates: [{ id: CUST_1, delivery_position: 0 }] }),
    );

    expect(res.status).toBe(500);
  });
});
