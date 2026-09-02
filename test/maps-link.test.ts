import { findMapsLink, isSharedPinLink } from "@/lib/maps/link";

describe("findMapsLink", () => {
  it("finds the link the webhook writes for a shared location", () => {
    const text = "[Lokasi dibagikan: Akasa BSD — BSD Baru]\nhttps://www.google.com/maps?q=-6.2853,106.6412";
    expect(findMapsLink(text)).toBe("https://www.google.com/maps?q=-6.2853,106.6412");
  });

  it("finds the links a customer pastes", () => {
    expect(findMapsLink("ini titiknya https://maps.app.goo.gl/aBcD1234 ya kak")).toBe(
      "https://maps.app.goo.gl/aBcD1234",
    );
    expect(findMapsLink("https://maps.google.com/maps?q=x")).toBe(
      "https://maps.google.com/maps?q=x",
    );
  });

  it("ignores a link that is not Maps", () => {
    expect(findMapsLink("https://www.google.com/search?q=pian+yi")).toBeNull();
    expect(findMapsLink("alamatnya Jl. Horizon Broadway Blok M.5")).toBeNull();
  });
});

describe("isSharedPinLink", () => {
  it("knows the link the webhook writes for a WhatsApp share-location", () => {
    expect(
      isSharedPinLink("https://www.google.com/maps?q=-6.2853,106.6412"),
    ).toBe(true);
  });

  it("does not claim a link the customer picked themselves", () => {
    expect(isSharedPinLink("https://maps.app.goo.gl/aBcD1234")).toBe(false);
    expect(
      isSharedPinLink("https://www.google.com/maps/place/Cendana+Cove"),
    ).toBe(false);
    expect(isSharedPinLink("https://maps.google.com/maps?q=cendana+cove")).toBe(
      false,
    );
  });
});
