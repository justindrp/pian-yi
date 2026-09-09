import { wroteTextBlind } from "@/app/api/webhook/whatsapp/route";

const textBlock = { type: "text" };
const toolBlock = { type: "tool_use" };

// Febby asked on 2026-09-09 to skip Kamis 10 and Jumat 11. delete_deliveries
// removed both rows and the sentence that went out six seconds later asked her
// "mau saya skip kedua tanggalnya?" — the model wrote it in the same response
// as the tool call, before the tool had run, so it had no way to know the write
// had landed.
describe("a reply written alongside its own tool call", () => {
  test("text and a tool call in one response is blind", () => {
    expect(wroteTextBlind({ content: [textBlock, toolBlock] }, "Mau saya skip?")).toBe(true);
  });

  test("a tool call with no text is not — that path already asks again", () => {
    expect(wroteTextBlind({ content: [toolBlock] }, "")).toBe(false);
  });

  test("whitespace is not text", () => {
    expect(wroteTextBlind({ content: [textBlock, toolBlock] }, "  \n ")).toBe(false);
  });

  test("a reply that called nothing is written knowing everything it can know", () => {
    expect(wroteTextBlind({ content: [textBlock] }, "Baik kak 😊")).toBe(false);
  });
});
