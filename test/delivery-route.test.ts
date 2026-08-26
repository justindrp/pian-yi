/**
 * `customers.delivery_route` is stored, not computed at read time: the daily
 * sheet, `/dapur/[id]` and the deliveries board all group on the stored column.
 * Every path that creates a customer stamped it from the area; no path that
 * updates one did, so a customer who moved areas kept the route of the area
 * they left. Sherine Fayola moved from BSD Lama to Gading Serpong on
 * 2026-08-26 and stayed on Route 1 — the wrong van, and the wrong rate, since
 * Route 1 is our own courier and the cheaper of the two.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDeliveryRoute, withDeliveryRoute } from "@/lib/utils/format";

// Every site that may write `area` onto an existing customer row.
const UPDATE_SITES = [
  "src/app/api/customers/[id]/route.ts",
  "src/app/api/assistant/execute/route.ts",
  "src/lib/claude/extract-order.ts",
];

describe("withDeliveryRoute", () => {
  it("restamps the route when the patch moves the area", () => {
    expect(withDeliveryRoute({ area: "Gading Serpong" })).toEqual({
      area: "Gading Serpong",
      delivery_route: 2,
    });
    expect(withDeliveryRoute({ area: "BSD Lama" })).toEqual({
      area: "BSD Lama",
      delivery_route: 1,
    });
  });

  it("leaves a patch that does not touch the area alone", () => {
    // A route set by hand on the Deliveries page must survive every unrelated
    // edit — a name fix must not silently re-route the customer.
    const patch = { name: "Sherine Fayola", delivery_route: 2 };
    expect(withDeliveryRoute(patch)).toBe(patch);
    expect(withDeliveryRoute({ notes: "gantung di pintu" })).toEqual({
      notes: "gantung di pintu",
    });
  });

  it("lets an explicit route in the same patch win", () => {
    // An admin setting both is overriding the map on purpose.
    expect(
      withDeliveryRoute({ area: "Gading Serpong", delivery_route: 1 }),
    ).toEqual({ area: "Gading Serpong", delivery_route: 1 });
  });

  it("clears the route for an area the map does not know", () => {
    // 14 customers sit in Ayodhya / Bintaro / Cisauk / Graha Raya. Unassigned
    // is the same answer the create paths give, and it is the honest one.
    expect(withDeliveryRoute({ area: "Bintaro" })).toEqual({
      area: "Bintaro",
      delivery_route: null,
    });
    expect(withDeliveryRoute({ area: null })).toEqual({
      area: null,
      delivery_route: null,
    });
  });

  it("maps every area the same way the create paths do", () => {
    expect(getDeliveryRoute("Alam Sutera")).toBe(1);
    expect(getDeliveryRoute("BSD Lama")).toBe(1);
    expect(getDeliveryRoute("Gading Serpong")).toBe(2);
    expect(getDeliveryRoute("BSD Baru")).toBe(2);
    expect(getDeliveryRoute("Karawaci")).toBe(2);
    expect(getDeliveryRoute("Bintaro")).toBeNull();
  });
});

describe("customer update sites", () => {
  it("leaves no site writing an area without a route beside it", () => {
    for (const site of UPDATE_SITES) {
      const src = readFileSync(join(process.cwd(), site), "utf8");
      // Either the patch goes through the helper, or the site stamps the route
      // inline the way extract-order.ts does.
      expect(src).toMatch(/withDeliveryRoute|delivery_route: getDeliveryRoute/);
    }
  });
});
