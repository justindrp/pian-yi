import { GET } from "@/app/api/deliveries/addable-customers/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user: { id: "u1", email: "admin@example.com" } } }) },
  });
});

describe("GET /api/deliveries/addable-customers", () => {
  test("T1 — unauthenticated returns 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null } }) },
    });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  test("T2 — returns only customers with an active package, with order attached", async () => {
    const db = makeDbMock({
      orders: {
        data: [
          { id: "ord-1", customer_id: "cust-1", portions_per_delivery: 2, portions_lunch: 0, portions_dinner: 0, meal_time_preference: "lunch_only", size: "s" },
        ],
        error: null,
      },
      customers: {
        data: [
          { id: "cust-1", name: "Alice", phone_number: "+628111", area: "BSD Baru", sub_area: null, address: "Jl A", google_maps_link: null, address_2: null, area_2: null, sub_area_2: null, google_maps_link_2: null, subcontractor_id: "sub-1", delivery_route: 1, delivery_position: 0 },
          { id: "cust-2", name: "Bob", phone_number: "+628222", area: "Karawaci", sub_area: null, address: "Jl B", google_maps_link: null, address_2: null, area_2: null, sub_area_2: null, google_maps_link_2: null, subcontractor_id: null, delivery_route: null, delivery_position: null },
        ],
        error: null,
      },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // Bob has no active package → excluded; only Alice returned.
    expect(json.data).toHaveLength(1);
    const alice = json.data[0];
    expect(alice.id).toBe("cust-1");
    expect(alice.active_order).toEqual(expect.objectContaining({ id: "ord-1", portions_per_delivery: 2 }));
  });
});
