import { NextResponse } from "next/server";
import { hasAdminAccess, getProfileForAuthUser } from "@/lib/auth/profile";
import { createClient as createAuthClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

type LoginByIdBody = {
  user_id?: unknown;
  password?: unknown;
};

function invalidCredentialsResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "Invalid credentials."
    },
    { status: 401 }
  );
}

export async function POST(request: Request) {
  let body: LoginByIdBody;

  try {
    body = (await request.json()) as LoginByIdBody;
  } catch {
    return invalidCredentialsResponse();
  }

  const userId = String(body.user_id ?? "").trim();
  const password = String(body.password ?? "");

  if (!userId || !password) {
    return invalidCredentialsResponse();
  }

  const serviceRoleClient = createServiceRoleClient();
  const { data: profileRow, error: profileError } = await serviceRoleClient
    .from("profiles")
    .select("auth_user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("login-by-id profile lookup failed", profileError);
    return invalidCredentialsResponse();
  }

  if (!profileRow?.auth_user_id) {
    return invalidCredentialsResponse();
  }

  const { data: authLookup, error: authLookupError } =
    await serviceRoleClient.auth.admin.getUserById(profileRow.auth_user_id);

  if (authLookupError || !authLookup.user?.email) {
    console.error("login-by-id auth lookup failed", authLookupError);
    return invalidCredentialsResponse();
  }

  const authClient = await createAuthClient();
  const { error: signInError } = await authClient.auth.signInWithPassword({
    email: authLookup.user.email,
    password
  });

  if (signInError) {
    console.error("login-by-id password sign-in failed", signInError);
    return invalidCredentialsResponse();
  }

  const {
    data: { user }
  } = await authClient.auth.getUser();

  if (!user) {
    console.error("login-by-id could not establish a session");
    return invalidCredentialsResponse();
  }

  const profile = await getProfileForAuthUser(authClient, user.id);
  const redirectTo =
    profile.role && hasAdminAccess(user.email, profile.role) ? "/" : "/user";

  return NextResponse.json({
    ok: true,
    redirectTo
  });
}
