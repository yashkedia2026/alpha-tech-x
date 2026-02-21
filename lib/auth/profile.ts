import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/auth/admin";

export type ProfileSummary = {
  role: string | null;
  user_id: string | null;
};

export async function getProfileForAuthUser(
  supabase: SupabaseClient,
  authUserId: string | null | undefined
): Promise<ProfileSummary> {
  if (!authUserId) {
    return {
      role: null,
      user_id: null
    };
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("role,user_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error || !data) {
    return {
      role: null,
      user_id: null
    };
  }

  return {
    role: typeof data.role === "string" ? data.role : null,
    user_id: typeof data.user_id === "string" ? data.user_id : null
  };
}

export function isAdminRole(role: string | null | undefined): boolean {
  return String(role ?? "").toLowerCase() === "admin";
}

export function hasAdminAccess(
  email: string | null | undefined,
  role: string | null | undefined
): boolean {
  return isAdminEmail(email) || isAdminRole(role);
}
