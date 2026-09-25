import { buildProofContactPrompt } from "@/lib/claude/prompts/proof-contact";
import {
  lookupProofContact,
  proofRecipientsFor,
} from "@/lib/customers/proof-contacts";

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

/**
 * The two queries `proofRecipientsFor` makes: the contacts on a customer, then
 * the `customers` rows those phone numbers happen to own.
 */
function stubRecipientDb(
  contacts: { id: string; phone_number: string; name: string | null }[],
  customers: { id: string; phone_number: string }[],
) {
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: async () => ({
          data: table === "customer_contacts" ? contacts : [],
        }),
        in: async (_col: string, phones: string[]) => ({
          data: customers.filter((c) => phones.includes(c.phone_number)),
        }),
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: a stub standing in for two queries
  return db as any;
}

describe("proofRecipientsFor", () => {
  it("returns nothing for a customer who registered nobody", async () => {
    expect(await proofRecipientsFor(stubRecipientDb([], []), "owner")).toEqual(
      [],
    );
  });

  it("carries the recipient's own customers row when they have written to us", async () => {
    const got = await proofRecipientsFor(
      stubRecipientDb(
        [{ id: "cc1", phone_number: "+6281526021414", name: "Abby" }],
        [{ id: "abby", phone_number: "+6281526021414" }],
      ),
      "ireine",
    );
    expect(got).toEqual([
      {
        id: "cc1",
        phone: "+6281526021414",
        name: "Abby",
        customerId: "abby",
      },
    ]);
  });

  it("leaves customerId null for a recipient who has never messaged", async () => {
    // No thread to write the send into and no inbound to measure a window
    // against — the send still goes, as a template.
    const got = await proofRecipientsFor(
      stubRecipientDb(
        [{ id: "cc2", phone_number: "+628180000000", name: "Satpam" }],
        [],
      ),
      "someone",
    );
    expect(got).toEqual([
      {
        id: "cc2",
        phone: "+628180000000",
        name: "Satpam",
        customerId: null,
      },
    ]);
  });

  it("keeps every recipient when a customer registered several", async () => {
    const got = await proofRecipientsFor(
      stubRecipientDb(
        [
          { id: "a", phone_number: "+62811", name: "Abby" },
          { id: "b", phone_number: "+62822", name: null },
        ],
        [{ id: "abby", phone_number: "+62811" }],
      ),
      "owner",
    );
    expect(got.map((r) => r.phone)).toEqual(["+62811", "+62822"]);
    expect(got[1]).toMatchObject({ name: null, customerId: null });
  });
});
