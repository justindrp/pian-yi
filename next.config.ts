import type { NextConfig } from "next";

// The public landing page renders the price-list PNG straight out of Supabase
// storage, so next/image needs the storage host on its allowlist. Derived from
// the env var rather than written out, so a project migration cannot leave a
// stale hostname behind — and skipped entirely when the var is absent, since a
// malformed URL here fails the whole build.
function supabaseImageHost() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return [];
  try {
    return [
      {
        protocol: "https" as const,
        hostname: new URL(url).hostname,
        pathname: "/storage/v1/object/public/**",
      },
    ];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  // pdfkit reads its font metrics off disk at runtime (js/data/*.afm). Bundling
  // it inlines the code and leaves the .afm files behind, so the first invoice
  // render in production would throw ENOENT — on a path that exists on every
  // developer's laptop. Kept external, and the data directory traced into the
  // standalone output by hand.
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/*": ["./node_modules/pdfkit/js/data/**"],
  },
  images: {
    remotePatterns: supabaseImageHost(),
  },
};

export default nextConfig;
