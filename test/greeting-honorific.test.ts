/**
 * The honorific belongs in the greeting variable, never in the sentence around
 * it. Writing `Halo kak ${firstName}` with a "kak" fallback for firstName
 * produces "Halo kak kak!" for every customer we have no name for — the same
 * doubling that put "Terima kasih kak kak!" in front of six real payment
 * messages between 2026-08-19 and 2026-08-25. extract-order.ts was fixed then;
 * four other send sites kept the old shape until 2026-08-26.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEND_SITES = [
  "src/app/api/orders/route.ts",
  "src/app/api/assistant/execute/route.ts",
  "src/lib/claude/extract-order.ts",
];

function greeting(name: string | null): string {
  const displayName = (name ?? "").trim().split(" ")[0];
  return displayName ? `kak ${displayName}` : "kak";
}

describe("customer greeting", () => {
  it("never doubles the honorific for an unnamed customer", () => {
    expect(`Halo ${greeting(null)}!`).toBe("Halo kak!");
    expect(`Halo ${greeting("")}!`).toBe("Halo kak!");
    expect(`Halo ${greeting("   ")}!`).toBe("Halo kak!");
  });

  it("uses the first name when there is one", () => {
    expect(`Halo ${greeting("Kurniadi Tan")}!`).toBe("Halo kak Kurniadi!");
    expect(`Halo ${greeting("Fahmi")}!`).toBe("Halo kak Fahmi!");
  });

  it("leaves no send site building the greeting the old way", () => {
    for (const site of SEND_SITES) {
      const src = readFileSync(join(process.cwd(), site), "utf8");
      expect(src).not.toMatch(/\|\|\s*"kak"/);
      expect(src).not.toMatch(/Halo kak \$\{(firstName|displayName)\}/);
      expect(src).not.toMatch(/Terima kasih kak \$\{(firstName|displayName)\}/);
    }
  });
});
