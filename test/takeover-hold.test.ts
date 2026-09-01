import {
  HOLD_CHOICES_MINUTES,
  holdUntil,
  isHeld,
  RESUMED_FLAGS,
  shouldAutoResume,
  TAKEOVER_INACTIVITY_MINUTES,
} from "@/lib/customers/takeover";

const NOW = Date.parse("2026-09-01T10:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("a takeover outlives the admin's silence", () => {
  test("the inactivity rule still hands back a thread nobody is holding", () => {
    expect(
      shouldAutoResume(
        { last_human_activity_at: minutesAgo(31), hold_until: null },
        NOW,
      ),
    ).toBe(true);
  });

  test("a hold in the future refuses however long the admin has been quiet", () => {
    // Carolin's refund thread: the last hand-written message was 30 minutes
    // back because we were waiting on her answer, not neglecting her. The bot
    // took the thread and answered her three times about a refund it cannot
    // make.
    expect(
      shouldAutoResume(
        {
          last_human_activity_at: minutesAgo(240),
          hold_until: new Date(NOW + 60 * 60_000).toISOString(),
        },
        NOW,
      ),
    ).toBe(false);
  });

  test("a hold that has passed stops holding", () => {
    expect(
      shouldAutoResume(
        {
          last_human_activity_at: minutesAgo(31),
          hold_until: minutesAgo(1),
        },
        NOW,
      ),
    ).toBe(true);
  });

  // The hold is not a second way to keep a thread with the human forever: once
  // it passes, the thread rejoins the ordinary sweep. 31 threads sat escalated
  // in August 2026 because nothing brought them back.
  test("a passed hold does not by itself resume a thread the admin just touched", () => {
    expect(
      shouldAutoResume(
        { last_human_activity_at: minutesAgo(2), hold_until: minutesAgo(1) },
        NOW,
      ),
    ).toBe(false);
  });

  test("a thread with no timestamp at all is still never auto-resumed", () => {
    expect(shouldAutoResume({ last_human_activity_at: null }, NOW)).toBe(false);
  });

  test("garbage in either column reads as not resumable", () => {
    expect(
      shouldAutoResume({ last_human_activity_at: "not a date" }, NOW),
    ).toBe(false);
    expect(isHeld("not a date", NOW)).toBe(false);
  });

  test("holdUntil counts forward from now", () => {
    expect(holdUntil(120, NOW)).toBe("2026-09-01T12:00:00.000Z");
    expect(isHeld(holdUntil(120, NOW), NOW)).toBe(true);
  });

  test("the default choice is the old behaviour", () => {
    expect(HOLD_CHOICES_MINUTES[0]).toBe(TAKEOVER_INACTIVITY_MINUTES);
  });

  // A hold left on a resumed thread would silence the bot for whatever the
  // customer says next, which is the failure this column exists to avoid.
  test("resuming clears the hold with the rest of the flags", () => {
    expect(RESUMED_FLAGS.hold_until).toBeNull();
    expect(RESUMED_FLAGS.escalated_to_human).toBe(false);
  });
});
