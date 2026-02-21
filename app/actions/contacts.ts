"use server";

import { revalidatePath } from "next/cache";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import type {
  Contact,
  ContactActionResult,
  ContactUpdateInput,
  ContactUpsertInput
} from "@/lib/contacts/types";
import { createClient } from "@/lib/supabase/server";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_COLUMNS = "account_key,name,email,updated_at";

function normalizeAccountKey(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeName(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeAccountKeys(accountKeys: string[]): string[] {
  return Array.from(
    new Set(accountKeys.map((accountKey) => normalizeAccountKey(accountKey)).filter(Boolean))
  );
}

function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

function filterContactsBySearch(contacts: Contact[], search: string): Contact[] {
  const searchTerm = search.trim().toLowerCase();
  if (!searchTerm) {
    return contacts;
  }

  return contacts.filter((contact) => {
    return (
      contact.account_key.toLowerCase().includes(searchTerm) ||
      (contact.name ?? "").toLowerCase().includes(searchTerm) ||
      contact.email.toLowerCase().includes(searchTerm)
    );
  });
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

export async function listContacts(search?: string): Promise<Contact[]> {
  if (!(await isAdminSession())) {
    return [];
  }

  const supabase = await createClient();
  const searchTerm = search?.trim();

  if (searchTerm) {
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .or(
        `account_key.ilike.%${searchTerm}%,name.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`
      )
      .order("updated_at", { ascending: false });

    if (!error) {
      return data ?? [];
    }

    console.error("listContacts SQL search failed, using fallback filter", error);
    const { data: fallbackData, error: fallbackError } = await supabase
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .order("updated_at", { ascending: false });

    if (fallbackError) {
      console.error("listContacts fallback query failed", fallbackError);
      return [];
    }

    return filterContactsBySearch(fallbackData ?? [], searchTerm);
  }

  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("listContacts query failed", error);
    return [];
  }

  return data ?? [];
}

export async function getContactsByKeys(
  accountKeys: string[]
): Promise<Record<string, Contact>> {
  if (!(await isAdminSession())) {
    return {};
  }

  const normalizedKeys = normalizeAccountKeys(accountKeys);
  if (normalizedKeys.length === 0) {
    return {};
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .in("account_key", normalizedKeys);

  if (error) {
    console.error("getContactsByKeys query failed", error);
    return {};
  }

  return (data ?? []).reduce<Record<string, Contact>>((acc, contact) => {
    acc[contact.account_key] = contact;
    return acc;
  }, {});
}

export async function createContact(
  payload: ContactUpsertInput
): Promise<ContactActionResult> {
  if (!(await isAdminSession())) {
    return {
      ok: false,
      error: "Not authorized to create contacts."
    };
  }

  const accountKey = normalizeAccountKey(payload.account_key);
  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);

  if (!accountKey) {
    return {
      ok: false,
      error: "Account key is required."
    };
  }

  if (!email) {
    return {
      ok: false,
      error: "Email is required."
    };
  }

  if (!isValidEmail(email)) {
    return {
      ok: false,
      error: "Email must be valid (example: name@example.com)."
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("contacts").insert({
    account_key: accountKey,
    name,
    email
  });

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        error: "A contact with this account key already exists."
      };
    }

    return {
      ok: false,
      error: error.message
    };
  }

  revalidatePath("/contacts");
  return { ok: true };
}

export async function updateContact(
  account_key: string,
  payload: ContactUpdateInput
): Promise<ContactActionResult> {
  if (!(await isAdminSession())) {
    return {
      ok: false,
      error: "Not authorized to update contacts."
    };
  }

  const accountKey = normalizeAccountKey(account_key);
  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);

  if (!accountKey) {
    return {
      ok: false,
      error: "Account key is required."
    };
  }

  if (!email) {
    return {
      ok: false,
      error: "Email is required."
    };
  }

  if (!isValidEmail(email)) {
    return {
      ok: false,
      error: "Email must be valid (example: name@example.com)."
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("contacts")
    .update({
      name,
      email
    })
    .eq("account_key", accountKey);

  if (error) {
    return {
      ok: false,
      error: error.message
    };
  }

  revalidatePath("/contacts");
  return { ok: true };
}

export async function deleteContact(
  account_key: string
): Promise<ContactActionResult> {
  if (!(await isAdminSession())) {
    return {
      ok: false,
      error: "Not authorized to delete contacts."
    };
  }

  const accountKey = normalizeAccountKey(account_key);
  if (!accountKey) {
    return {
      ok: false,
      error: "Account key is required."
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("contacts")
    .delete()
    .eq("account_key", accountKey);

  if (error) {
    return {
      ok: false,
      error: error.message
    };
  }

  revalidatePath("/contacts");
  return { ok: true };
}
