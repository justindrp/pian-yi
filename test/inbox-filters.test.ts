import { filterThreads } from "@/components/dashboard/inbox-filters";

describe("filterThreads", () => {
  const threads = [
    { unread: true, unanswered: false, id: "unread-only" },
    { unread: false, unanswered: true, id: "unanswered-only" },
    { unread: true, unanswered: true, id: "both" },
    { unread: false, unanswered: false, id: "neither" },
  ];

  test("returns all threads for the all filter", () => {
    expect(filterThreads(threads, "all").map((thread) => thread.id)).toEqual([
      "unread-only",
      "unanswered-only",
      "both",
      "neither",
    ]);
  });

  test("returns only unread threads for the unread filter", () => {
    expect(filterThreads(threads, "unread").map((thread) => thread.id)).toEqual(
      ["unread-only", "both"],
    );
  });

  test("returns only unanswered threads for the unanswered filter", () => {
    expect(
      filterThreads(threads, "unanswered").map((thread) => thread.id),
    ).toEqual(["unanswered-only", "both"]);
  });
});
