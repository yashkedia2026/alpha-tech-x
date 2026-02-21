"use server";

import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";

type LastSendStatus = {
  status: "sent" | "failed" | null;
  sent_at: string | null;
};

function normalizeZipFilename(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeAccountKey(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeAccountKeys(accountKeys: string[]): string[] {
  return Array.from(
    new Set(accountKeys.map((accountKey) => normalizeAccountKey(accountKey)).filter(Boolean))
  );
}

async function isAdminSession(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: claimsData,
    error: claimsError
  } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(!claimsError && claimsData?.claims);

  if (!isAuthenticated) {
    return false;
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  const profile = await getProfileForAuthUser(supabase, user?.id);

  return hasAdminAccess(user?.email ?? null, profile.role);
}

export async function getLastSendStatusForZip(
  zip_filename: string,
  accountKeys: string[]
): Promise<Record<string, LastSendStatus>> {
  if (!(await isAdminSession())) {
    return {};
  }

  const zipFilename = normalizeZipFilename(zip_filename);
  const normalizedKeys = normalizeAccountKeys(accountKeys);

  if (!zipFilename || normalizedKeys.length === 0) {
    return {};
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("send_logs")
    .select("account_key,status,sent_at")
    .eq("zip_filename", zipFilename)
    .in("account_key", normalizedKeys)
    .order("sent_at", { ascending: false });

  if (error) {
    console.error("getLastSendStatusForZip query failed", error);
    return {};
  }

  return (data ?? []).reduce<Record<string, LastSendStatus>>((acc, row) => {
    const accountKey = normalizeAccountKey(row.account_key);
    if (!accountKey || acc[accountKey]) {
      return acc;
    }

    const status =
      row.status === "sent" || row.status === "failed"
        ? row.status
        : null;

    acc[accountKey] = {
      status,
      sent_at: typeof row.sent_at === "string" ? row.sent_at : null
    };

    return acc;
  }, {});
}
