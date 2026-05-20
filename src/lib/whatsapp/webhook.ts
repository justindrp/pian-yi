import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  body: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac(
    "sha256",
    process.env.WHATSAPP_APP_SECRET!,
  )
    .update(body)
    .digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
