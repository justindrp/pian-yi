# Biome `biome-ignore` Inventory

Every `biome-ignore` suppression in the codebase, grouped by rule. Each entry lists where it lives and why the rule is intentionally disabled at that site.

Last updated: 2026-06-27 (34 suppressions across 18 files).

---

## `lint/performance/noImgElement` — `<img>` instead of `next/image`

next/image is impractical for these sources (signed Supabase URLs, external WhatsApp media, API-route media, local object previews) because they require dynamic remote-pattern config or fixed width/height that these variable-size chat/dashboard thumbnails don't have. All are low-traffic admin dashboard renders.

| File | Line | Reason |
|------|------|--------|
| `src/components/dashboard/deliveries-client.tsx` | 674 | Signed Supabase URL — next/image impractical |
| `src/components/dashboard/deliveries-client.tsx` | 696 | Signed Supabase URL — next/image impractical |
| `src/components/dashboard/deliveries-client.tsx` | 713 | Signed Supabase URL — next/image impractical |
| `src/components/dashboard/deliveries-client.tsx` | 741 | Signed Supabase URL — next/image impractical |
| `src/components/dashboard/deliveries-client.tsx` | 783 | Signed Supabase URL — next/image impractical |
| `src/components/dashboard/settings-client.tsx` | 425 | Supabase Storage URL — next/image impractical |
| `src/components/dashboard/subcontractors-client.tsx` | 122 | Supabase Storage URL — next/image impractical |
| `src/components/dashboard/inbox-client.tsx` | 564 | Media served via API route — next/image impractical |
| `src/components/dashboard/inbox-client.tsx` | 572 | External WhatsApp media URL — next/image impractical |
| `src/components/dashboard/inbox-client.tsx` | 646 | Local object URL preview — next/image impractical |

---

## `lint/suspicious/noArrayIndexKey` — using array index as React key

Safe only because these lists are static skeletons or append-only chat logs where items never reorder, insert, or delete — index is a stable identity.

| File | Line | Reason |
|------|------|--------|
| `src/app/(dashboard)/loading.tsx` | 7 | Static skeleton |
| `src/components/dashboard/orders-client.tsx` | 101 | Static skeleton list |
| `src/components/dashboard/reports-client.tsx` | 149 | Static skeleton list |
| `src/components/dashboard/reports-client.tsx` | 424 | Static skeleton list |
| `src/components/dashboard/chatbot-training-client.tsx` | 163 | Ephemeral chat messages have no stable id |
| `src/components/dashboard/chatbot-training-client.tsx` | 516 | Chat bubbles are append-only |
| `src/components/dashboard/chatbot-training-client.tsx` | 526 | Chat bubbles are append-only |
| `src/components/dashboard/chatbot-training-client.tsx` | 535 | Chat bubbles are append-only |

---

## `lint/suspicious/noThenProperty` — mocked object is `.then()`-able

Used in tests on mocked Supabase query builders. Biome flags the mock because it exposes a `.then` property (making it thenable); the mock intentionally mimics the real PostgrestBuilder so `await supabase.from(...)` resolves correctly in tests.

| File | Line |
|------|------|
| `test/api/inbox.test.ts` | 34 |
| `test/api/assistant.test.ts` | 44 |
| `test/api/manual-image.test.ts` | 30 |
| `test/api/orders.test.ts` | 34 |
| `test/api/settings.test.ts` | 27 |
| `test/api/assistant-execute.test.ts` | 30 |
| `test/api/customers-delete.test.ts` | 24 |
| `test/api/delivery-proofs.test.ts` | 24 |
| `test/api/assistant-history.test.ts` | 22 |
| `test/api/orders-post.test.ts` | 28 |
| `test/webhook.test.ts` | 63 |

---

## `lint/suspicious/noExplicitAny` — intentional `any`

| File | Line | Reason |
|------|------|--------|
| `src/app/api/assistant/execute/route.ts` | 175 | Dynamic field from validated allowlist — key is checked against `ALLOWED_CUSTOMER_FIELDS` set before use |
| `test/webhook.test.ts` | 134 | Test payload — shape intentionally loose |

---

## `lint/a11y/useSemanticElements` — interactive `<tr>`

| File | Line | Reason |
|------|------|--------|
| `src/components/dashboard/customers-client.tsx` | 268 | Interactive table row — row needs onClick + nested form controls; `<button>` cannot wrap `<td>`/form elements semantically |

---

## `lint/a11y/noAutofocus` — intentional focus management

| File | Line | Reason |
|------|------|--------|
| `src/components/dashboard/customers-client.tsx` | 319 | Intentional inline edit activation — focusing the input on cell-edit open is the desired UX |

---

## `lint/correctness/useExhaustiveDependencies` — partial effect deps

| File | Line | Reason |
|------|------|--------|
| `src/components/dashboard/inbox-client.tsx` | 181 | `useEffect` intentionally scrolls only on message change, not on every dep — adding other deps would trigger unwanted rescrolls |

---

## Maintenance

- When adding a new `biome-ignore`, add a row to this file in the same commit.
- When removing suppressed code, delete the corresponding row.
- Run `grep -rn "biome-ignore" src/ test/ scripts/` to regenerate — line numbers shift with edits, re-verify before relying on them.
