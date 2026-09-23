/**
 * Who works for us, from `settings.team_roster` (migration 137): one person per
 * line, "Nama — peran", with the WhatsApp number they use on the line when
 * people outside may be contacted from it.
 *
 * The bot had no such list. On 2026-09-23 a kitchen owner (+6281999915959)
 * was approached by Jennifer about becoming a dapur partner and asked us to
 * confirm her. The bot could neither confirm nor deny who ran the business,
 * then — after an admin had confirmed her by hand — told the kitchen to hold
 * off on "pihak tersebut" while it "checked", twice, because nothing it could
 * see said she was ours.
 */
export function parseTeamRoster(raw: string): {
  lines: string[];
  names: string[];
} {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // The name is whatever precedes the first separator. A line with none is all
  // name, which is what someone typing just "Friska" means.
  const names = lines
    .map((l) => l.split(/\s[—–-]\s|:|,/)[0].trim())
    .filter(Boolean);
  return { lines, names };
}

/** Whether `text` mentions one of `names` as a whole word, ignoring case. */
export function mentionsTeamMember(text: string, names: string[]): boolean {
  return names.some((n) =>
    new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
      text,
    ),
  );
}
