import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

export async function proxy(req: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            req.cookies.set(name, value);
            response = NextResponse.next({ request: req });
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Protect dashboard routes
  if (
    pathname.startsWith("/(dashboard)") ||
    pathname === "/" ||
    (pathname !== "/login" &&
      !pathname.startsWith("/api") &&
      !pathname.startsWith("/_next") &&
      !pathname.startsWith("/callback"))
  ) {
    if (
      !user &&
      pathname !== "/login" &&
      !pathname.startsWith("/api") &&
      !pathname.startsWith("/_next")
    ) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.json|icons).*)",
  ],
};
