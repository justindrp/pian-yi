/**
 * How a kitchen seasons, in the three states the question actually has.
 *
 * `subcontractors.msg_policy` (migration 124). It was a boolean for one day —
 * `uses_msg`, migration 123 — and a boolean put Thenie at the wrong end of it:
 * they do not cook with micin and their food is not free of flavour enhancer
 * either, it is kaldu jamur. Both ends of a boolean are a lie to the person
 * asking, and the person asking is avoiding MSG.
 *
 * NULL is "we have never asked that kitchen" and is never `none`. It is the
 * escalation state, because guessing on a kitchen's behalf is what this column
 * exists to stop.
 */
export const MSG_POLICIES = ["none", "penyedap", "msg"] as const;

export type MsgPolicy = (typeof MSG_POLICIES)[number];

/**
 * The column narrowed to the union. The generated type is `string | null` —
 * the check constraint lives in the database, not in TypeScript — so anything
 * unrecognised reads as "never asked" rather than as an answer.
 */
export function asMsgPolicy(value: string | null): MsgPolicy | null {
  return MSG_POLICIES.includes(value as MsgPolicy)
    ? (value as MsgPolicy)
    : null;
}
