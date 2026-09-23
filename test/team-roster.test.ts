import { mentionsTeamMember, parseTeamRoster } from "@/lib/claude/team-roster";

describe("parseTeamRoster", () => {
  it("takes the name before the first separator", () => {
    const { lines, names } = parseTeamRoster(
      "Justin — owner\n\nJennifer — asisten pribadi Justin, +6281234567890\nFriska\n",
    );
    expect(lines).toHaveLength(3);
    expect(names).toEqual(["Justin", "Jennifer", "Friska"]);
  });

  it("is empty for an empty setting", () => {
    expect(parseTeamRoster("")).toEqual({ lines: [], names: [] });
  });
});

describe("mentionsTeamMember", () => {
  const names = ["Justin", "Jennifer"];

  it("matches the claim that blocked the 2026-09-23 reply", () => {
    expect(
      mentionsTeamMember("Jennifer memang bagian dari tim kami", names),
    ).toBe(true);
  });

  it("ignores a customer's own name and partial words", () => {
    expect(mentionsTeamMember("Kak Natalie", names)).toBe(false);
    expect(mentionsTeamMember("Jenniferia", names)).toBe(false);
  });
});
