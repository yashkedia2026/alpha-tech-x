const rawAllowlist = process.env.ALPHA_TECH_X_ADMIN_EMAILS ?? "";

const normalizedAllowlist = new Set(
  rawAllowlist
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }

  return normalizedAllowlist.has(email.trim().toLowerCase());
}
