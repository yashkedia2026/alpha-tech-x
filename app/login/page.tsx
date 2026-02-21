import { redirect } from "next/navigation";
import LoginForm from "@/components/login-form";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await createClient();
  const {
    data: claimsData,
    error: claimsError
  } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(!claimsError && claimsData?.claims);

  if (isAuthenticated) {
    const {
      data: { user }
    } = await supabase.auth.getUser();
    const userEmail = user?.email ?? null;
    const profile = await getProfileForAuthUser(supabase, user?.id);
    redirect(hasAdminAccess(userEmail, profile.role) ? "/" : "/user");
  }

  return (
    <main className="page-shell">
      <section className="card">
        <h1>ALPHA-TECH X</h1>
        <p className="subtitle">Admin portal</p>
        <LoginForm />
      </section>
    </main>
  );
}
