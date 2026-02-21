import { NextResponse, type NextRequest } from "next/server";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/middleware";

function redirectWithCookies(
  request: NextRequest,
  pathname: string,
  sourceResponse: NextResponse
) {
  const target = new URL(pathname, request.url);
  const redirectResponse = NextResponse.redirect(target);

  sourceResponse.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie);
  });

  return redirectResponse;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname === "/login";
  const isCallbackRoute = pathname === "/auth/callback";
  const isAccessDeniedRoute = pathname === "/access-denied";
  const isAdminRoute = pathname === "/" || pathname.startsWith("/contacts");

  if (isCallbackRoute) {
    return NextResponse.next();
  }

  const { supabase, response } = createClient(request);
  const {
    data: claimsData,
    error: claimsError
  } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(!claimsError && claimsData?.claims);

  if (isLoginRoute) {
    if (!isAuthenticated) {
      return response;
    }

    const {
      data: { user }
    } = await supabase.auth.getUser();
    const userEmail = user?.email ?? null;
    const profile = await getProfileForAuthUser(supabase, user?.id);
    const isAdmin = hasAdminAccess(userEmail, profile.role);

    return isAdmin
      ? redirectWithCookies(request, "/", response)
      : redirectWithCookies(request, "/user", response);
  }

  if (!isAuthenticated) {
    return redirectWithCookies(request, "/login", response);
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  const userEmail = user?.email ?? null;
  const profile = await getProfileForAuthUser(supabase, user?.id);
  const isAdmin = hasAdminAccess(userEmail, profile.role);

  if (isAdminRoute && !isAdmin) {
    return redirectWithCookies(request, "/access-denied", response);
  }

  if (isAccessDeniedRoute && isAdmin) {
    return redirectWithCookies(request, "/", response);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|_actions|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"
  ]
};
