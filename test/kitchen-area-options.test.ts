import { kitchensForCustomerArea } from "@/lib/subcontractors/for-customer";

type Kitchen = {
  id: string;
  customer_nickname: string;
  delivery_areas: string[] | null;
};

/**
 * Enough of PostgREST for this one function: `customers` answers a
 * `maybeSingle`, `subcontractors` answers an awaited `eq`.
 */
function db(customer: { area: string | null; area_2?: string | null } | null, kitchens: Kitchen[]) {
  return {
    from(table: string) {
      if (table === "customers") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: customer }) }),
          }),
        };
      }
      return {
        select: () => ({
          eq: async () => ({ data: kitchens }),
        }),
      };
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub, not a real client
  } as any;
}

const SUPLIR = { id: "suplir", customer_nickname: "Dapur Suplir", delivery_areas: ["Alam Sutera", "BSD Lama", "Karawaci"] };
const PALEM = { id: "palem", customer_nickname: "Dapur Palem", delivery_areas: ["Bintaro"] };
const MONSTERA = { id: "monstera", customer_nickname: "Dapur Monstera", delivery_areas: ["Alam Sutera", "Bintaro"] };

describe("kitchensForCustomerArea", () => {
  it("drops a kitchen that no longer carries the customer's area", async () => {
    const got = await kitchensForCustomerArea(
      db({ area: "Alam Sutera" }, [SUPLIR, PALEM, MONSTERA]),
      "c1",
    );
    expect(got.map((k) => k.id)).toEqual(["suplir", "monstera"]);
  });

  it("keeps a kitchen that carries the customer's second area", async () => {
    const got = await kitchensForCustomerArea(
      db({ area: "Karawaci", area_2: "Bintaro" }, [SUPLIR, PALEM, MONSTERA]),
      "c1",
    );
    expect(got.map((k) => k.id)).toEqual(["suplir", "palem", "monstera"]);
  });

  it("shows every active kitchen to someone who has not said where they are", async () => {
    const got = await kitchensForCustomerArea(
      db({ area: null }, [SUPLIR, PALEM, MONSTERA]),
      "c1",
    );
    expect(got).toHaveLength(3);
  });

  it("falls back to every active kitchen for an area nobody covers", async () => {
    const got = await kitchensForCustomerArea(
      db({ area: "Surabaya" }, [SUPLIR, PALEM, MONSTERA]),
      "c1",
    );
    expect(got).toHaveLength(3);
  });

  it("ignores the customer's assigned kitchen — the list is what they may pick from", async () => {
    // kitchensForCustomer would return only the assigned one; this must not.
    const got = await kitchensForCustomerArea(
      db({ area: "Bintaro" }, [SUPLIR, PALEM, MONSTERA]),
      "c1",
    );
    expect(got.map((k) => k.id)).toEqual(["palem", "monstera"]);
  });
});
