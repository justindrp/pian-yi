import { matchCustomerByName, parseGrantPaste } from "@/lib/grants/parse-paste";

describe("parseGrantPaste", () => {
  test("reads tab-separated rows the way Sheets puts them on the clipboard", () => {
    const rows = parseGrantPaste(
      "Defi Lugito\t6\t2026-08-14\tkompensasi telat\nValen\t4\t2026-08-14\tkompensasi telat",
    );
    expect(rows).toEqual([
      {
        name: "Defi Lugito",
        portions: 6,
        date: "2026-08-14",
        reason: "kompensasi telat",
      },
      {
        name: "Valen",
        portions: 4,
        date: "2026-08-14",
        reason: "kompensasi telat",
      },
    ]);
  });

  test("a negative cell is the size of the shortfall, not an error", () => {
    // docs/OVERDRAW.md lists balances as "-3"; that is 3 portions to grant.
    expect(parseGrantPaste("Darren\t-3")[0].portions).toBe(3);
  });

  test("splits on tabs when present so a reason may contain commas", () => {
    const rows = parseGrantPaste("Tia\t4\t2026-08-14\tterlambat, minta maaf");
    expect(rows[0].reason).toBe("terlambat, minta maaf");
  });

  test("accepts comma-separated rows for hand-edited lists", () => {
    expect(parseGrantPaste("Herlina,4")[0]).toEqual({
      name: "Herlina",
      portions: 4,
      date: null,
      reason: "",
    });
  });

  test("accepts d/m/Y as well as ISO dates", () => {
    expect(parseGrantPaste("Tia\t1\t14/08/2026")[0].date).toBe("2026-08-14");
    expect(parseGrantPaste("Tia\t1\t2026-08-14")[0].date).toBe("2026-08-14");
    expect(parseGrantPaste("Tia\t1\tkemarin")[0].date).toBeNull();
  });

  test("missing or unreadable portions come back null rather than guessed", () => {
    expect(parseGrantPaste("Tia")[0].portions).toBeNull();
    expect(parseGrantPaste("Tia\t\t2026-08-14")[0].portions).toBeNull();
    expect(parseGrantPaste("Tia\t0")[0].portions).toBeNull();
  });

  test("drops blank lines and nameless rows", () => {
    expect(parseGrantPaste("\n\nTia\t2\n\n")).toHaveLength(1);
    expect(parseGrantPaste("\t5\t2026-08-14")).toHaveLength(0);
  });
});

describe("matchCustomerByName", () => {
  const customers = [
    { id: "a", name: "Defi Lugito", phone_number: "+628111111111" },
    { id: "b", name: "Valen", phone_number: "+628222222222" },
    { id: "c", name: "Valen", phone_number: "+628333333333" },
    { id: "d", name: "Tia", phone_number: null },
  ];

  test("matches a unique name, case- and space-insensitively", () => {
    expect(matchCustomerByName("  defi lugito ", customers)?.id).toBe("a");
  });

  test("refuses to guess between two customers with the same name", () => {
    // Attaching a grant to the wrong ledger is invisible once written.
    expect(matchCustomerByName("Valen", customers)).toBeNull();
  });

  test("matches on a pasted phone number regardless of +62 / 62 / 0 form", () => {
    expect(matchCustomerByName("08111111111", customers)?.id).toBe("a");
    expect(matchCustomerByName("+628111111111", customers)?.id).toBe("a");
  });

  test("returns null for an unknown name", () => {
    expect(matchCustomerByName("Nobody", customers)).toBeNull();
    expect(matchCustomerByName("", customers)).toBeNull();
  });
});
