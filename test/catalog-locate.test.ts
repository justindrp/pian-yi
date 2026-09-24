import { matchArea, type NeighborhoodPoint } from "@/lib/catalog/locate";

const points: NeighborhoodPoint[] = [
  { area: "BSD Baru", excluded: false, lat: -6.3, lng: 106.64 },
  { area: "Alam Sutera", excluded: false, lat: -6.24, lng: 106.65 },
  { area: "Alam Sutera", excluded: true, lat: -6.23, lng: 106.66 },
  { area: "Karawaci", excluded: false, lat: -6.22, lng: 106.6 },
];
const served = ["BSD Baru", "Alam Sutera"];

describe("matchArea", () => {
  it("returns the area of the nearest neighbourhood", () => {
    expect(matchArea(points, served, -6.301, 106.641)).toBe("BSD Baru");
    expect(matchArea(points, served, -6.241, 106.649)).toBe("Alam Sutera");
  });

  it("refuses a position far from every neighbourhood", () => {
    expect(matchArea(points, served, -6.9, 107.6)).toBeNull();
  });

  it("refuses when the nearest neighbourhood is excluded, even inside a served area", () => {
    expect(matchArea(points, served, -6.2301, 106.6601)).toBeNull();
  });

  it("refuses an area no active kitchen serves rather than rounding to one that is", () => {
    expect(matchArea(points, served, -6.221, 106.601)).toBeNull();
  });

  it("refuses when nothing has been placed", () => {
    expect(matchArea([], served, -6.3, 106.64)).toBeNull();
  });
});
