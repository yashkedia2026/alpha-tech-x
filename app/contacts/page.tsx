import { redirect } from "next/navigation";
import { listContacts } from "@/app/actions/contacts";
import ConsoleHeader from "@/components/console-header";
import ContactsManager from "@/components/contacts-manager";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";

export default async function ContactsPage() {
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

  if (!hasAdminAccess(userEmail, profile.role)) {
    redirect("/access-denied");
  }

  const contacts = await listContacts();

  return (
    <main className="console-shell">
      <section className="console">
        <ConsoleHeader activeTab="contacts" userEmail={userEmail} />
        <ContactsManager initialContacts={contacts} />
      </section>
    </main>
  );
}
