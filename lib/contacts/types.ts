export type Contact = {
  account_key: string;
  name: string | null;
  email: string;
  updated_at: string;
};

export type ContactUpsertInput = {
  account_key: string;
  name?: string | null;
  email: string;
};

export type ContactUpdateInput = {
  name?: string | null;
  email: string;
};

export type ContactActionResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };
