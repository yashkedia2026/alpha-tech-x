import { NextResponse } from "next/server";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", request.url));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=callback_failed`, request.url)
    );
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login?error=session_missing", request.url));
  }

  const profile = await getProfileForAuthUser(supabase, user.id);
  const redirectPath = hasAdminAccess(user.email, profile.role) ? "/" : "/user";

  return NextResponse.redirect(new URL(redirectPath, request.url));
}
