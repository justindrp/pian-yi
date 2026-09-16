import { buildProofContactPrompt } from "@/lib/claude/prompts/proof-contact";
import { lookupProofContact } from "@/lib/customers/proof-contacts";

type Row = { name: string | null; customer_id: string; customers: unknown };

/** The one query shape `lookupProofContact` makes, with the phone it asked for. */
function stubDb(row: Row | null) {
  const asked: string[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: (_col: string, value: string) => {
          asked.push(value);
          return { maybeSingle: async () => ({ data: row }) };
        },
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: a stub standing in for one query
  return { db: db as any, asked };
}

describe("lookupProofContact", () => {
  test("an admin's 0812… finds the row stored as +62812…", async () => {
    const { db, asked } = stubDb({
      name: "Abby",
      customer_id: "ireine",
      customers: { name: "Ireine Roosdy" },
    });
    const contact = await lookupProofContact(db, "0815-2602-1414");
    expect(asked).toEqual(["+6281526021414"]);
    expect(contact).toEqual({
      ownerId: "ireine",
      ownerName: "Ireine Roosdy",
      contactName: "Abby",
    });
  });

  test("an unreadable number is nobody, and asks the database nothing", async () => {
    const { db, asked } = stubDb(null);
    expect(await lookupProofContact(db, "halo")).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a number with no row is not a recipient", async () => {
    const { db } = stubDb(null);
    expect(await lookupProofContact(db, "+6281213098656")).toBeNull();
  });
});

describe("buildProofContactPrompt", () => {
  const prompt = buildProofContactPrompt({
    ownerName: "Ireine Roosdy",
    contactName: "Abby",
    todayLabel: "Rabu 16 September 2026",
  });

  test("names the recipient and says whose order it is", () => {
    expect(prompt).toContain("Abby");
    expect(prompt).toContain("Ireine Roosdy");
    expect(prompt).toContain("bukan pemesannya");
  });

  test("the two tools are the only ones it offers", () => {
    expect(prompt).toContain("send_delivery_proof");
    expect(prompt).toContain("ask_admin_for_help");
    expect(prompt).not.toContain("extract_order");
    expect(prompt).not.toContain("record_daily_order");
  });

  test("the ledger is off limits: price, quota, payment, kitchen", () => {
    expect(prompt).toContain(
      "Jangan pernah menyebut harga, sisa kuota, status pembayaran, nama dapur",
    );
  });
});
