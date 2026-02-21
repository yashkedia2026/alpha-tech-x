import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";

type ConsoleHeaderProps = {
  activeTab: "upload" | "contacts";
  userEmail: string | null;
};

export default function ConsoleHeader({
  activeTab,
  userEmail
}: ConsoleHeaderProps) {
  return (
    <>
      <header className="console-top">
        <div>
          <h1>ALPHA-TECH X</h1>
          <p className="subtitle">Upload bills ZIP and send PDFs to mapped contacts</p>
        </div>

        <div style={{ display: "grid", gap: 10, justifyItems: "end" }}>
          <span className="user-chip">{userEmail ?? "Unknown email"}</span>
          <form action={signOutAction}>
            <button type="submit" className="button button-secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <nav className="tab-row" aria-label="Primary">
        <Link
          href="/"
          className={`tab ${activeTab === "upload" ? "tab-active" : ""}`}
        >
          Upload &amp; Send
        </Link>
        <Link
          href="/contacts"
          className={`tab ${activeTab === "contacts" ? "tab-active" : ""}`}
        >
          Contacts
        </Link>
      </nav>
    </>
  );
}
