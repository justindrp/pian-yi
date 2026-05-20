export function GET() {
  return Response.json({ ok: true, service: "pian-yi", ts: Date.now() });
}
