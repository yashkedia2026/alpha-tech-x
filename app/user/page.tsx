import { redirect } from "next/navigation";
import { signOutAction } from "@/app/actions/auth";
import { getProfileForAuthUser } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";

export default async function UserPage() {
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

  if (!user) {
    redirect("/login");
  }

  const profile = await getProfileForAuthUser(supabase, user.id);

  return (
    <main className="console-shell">
      <section className="console">
        <h1>Tech X Edu — User Portal (Coming Soon)</h1>
        <p className="subtitle">Authenticated user area</p>

        <div className="placeholder-box">
          <p>
            <strong>User ID:</strong> {profile.user_id ?? "Not set"}
          </p>
          <p>
            <strong>Email:</strong> {user.email ?? "Unknown email"}
          </p>
        </div>

        <form action={signOutAction} className="form-stack">
          <button type="submit" className="button button-secondary">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
