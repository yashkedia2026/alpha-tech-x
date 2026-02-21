create table if not exists public.contacts (
  account_key text primary key,
  name text,
  email text not null,
  updated_at timestamptz not null default now()
);

create index if not exists contacts_updated_at_idx
  on public.contacts (updated_at desc);

create or replace function public.set_contacts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at
before update on public.contacts
for each row
execute function public.set_contacts_updated_at();

alter table public.contacts enable row level security;

drop policy if exists contacts_select_authenticated on public.contacts;
create policy contacts_select_authenticated
  on public.contacts
  for select
  to authenticated
  using (true);

drop policy if exists contacts_insert_authenticated on public.contacts;
create policy contacts_insert_authenticated
  on public.contacts
  for insert
  to authenticated
  with check (true);

drop policy if exists contacts_update_authenticated on public.contacts;
create policy contacts_update_authenticated
  on public.contacts
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists contacts_delete_authenticated on public.contacts;
create policy contacts_delete_authenticated
  on public.contacts
  for delete
  to authenticated
  using (true);
