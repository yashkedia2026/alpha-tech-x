import Link from "next/link";
import { redirect } from "next/navigation";
import { signOutAction } from "@/app/actions/auth";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";

export default async function AccessDeniedPage() {
  const supabase = await createClient();
  const {
    data: claimsData,
    error: claimsError
  } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(!claimsError && claimsData?.claims);

  if (!isAuthenticated) {
    redirect("/login");
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  const userEmail = user?.email ?? null;
  const profile = await getProfileForAuthUser(supabase, user?.id);

  if (hasAdminAccess(userEmail, profile.role)) {
    redirect("/");
  }

  return (
    <main className="page-shell">
      <section className="card">
        <h2>Admin access required</h2>
        <p className="subtitle">
          Your account is signed in, but this page is only available to admins.
        </p>

        <div className="denied">
          Signed in as <strong>{userEmail ?? "Unknown email"}</strong>
          <br />
          User ID: <strong>{profile.user_id ?? "Not set"}</strong>
        </div>

        <Link href="/user" className="button button-secondary" style={{ marginTop: 12 }}>
          Go to User Portal
        </Link>

        <form action={signOutAction} className="form-stack">
          <button type="submit" className="button button-danger">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
