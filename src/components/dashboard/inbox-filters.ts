type ThreadWithInboxFlags = {
  unread: boolean;
  unanswered: boolean;
};

export type InboxFilter = "all" | "unread" | "unanswered";

export function filterThreads<T extends ThreadWithInboxFlags>(
  threads: T[],
  filter: InboxFilter,
) {
  if (filter === "unread") {
    return threads.filter((thread) => thread.unread);
  }

  if (filter === "unanswered") {
    return threads.filter((thread) => thread.unanswered);
  }

  return threads;
}
