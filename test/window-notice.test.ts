import {
  WINDOW_NOTICE_CLAUSE,
  WINDOW_NOTICE_SHORT,
  WINDOW_NOTICE_WELCOME,
} from "@/lib/whatsapp/window-notice";

const ALL = [
  WINDOW_NOTICE_WELCOME,
  WINDOW_NOTICE_SHORT,
  WINDOW_NOTICE_CLAUSE,
];

// "Jalurnya terkunci" on its own reads as our choice — our office hours, our
// staffing — and customers answer it with fixes for a problem we do not have.
// Bu Mimi proposed a telephone call and published opening hours on 2026-09-03.
// Naming the account type is what makes the limit legible as WhatsApp's.
describe("the window notice names the account type", () => {
  test("every length says WhatsApp Business API", () => {
    for (const notice of ALL) {
      expect(notice).toContain("WhatsApp Business API");
    }
  });

  test("the two long ones say it is not an ordinary WhatsApp", () => {
    expect(WINDOW_NOTICE_WELCOME).toContain("bukan WhatsApp biasa");
    expect(WINDOW_NOTICE_SHORT).toContain("bukan WhatsApp biasa");
  });

  // The number has no telephone at all, and a customer told otherwise waits
  // for a call that can never come.
  test("neither long notice offers a call as a way round the lock", () => {
    for (const notice of [WINDOW_NOTICE_WELCOME, WINDOW_NOTICE_SHORT]) {
      expect(notice).toMatch(/tidak bisa menelepon|tidak bisa chat duluan/);
    }
  });

  test("the ask is still the customer writing first", () => {
    expect(WINDOW_NOTICE_WELCOME).toContain("kakak chat kami duluan");
    expect(WINDOW_NOTICE_SHORT).toContain("kakak chat kami duluan");
  });
});
