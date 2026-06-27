/**
 * Reads a required env var. Throws a clear error at the call site if missing,
 * instead of letting an `undefined` propagate and crash deeper.
 *
 * Value is passed explicitly (not the key alone) so Next.js static replacement
 * of NEXT_PUBLIC_* vars is preserved for client bundles.
 */
export function requiredEnv(key: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}
