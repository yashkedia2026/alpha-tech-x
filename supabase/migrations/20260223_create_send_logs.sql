create extension if not exists pgcrypto with schema extensions;

create table if not exists public.send_logs (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  zip_filename text not null,
  account_key text not null,
  trade_date text,
  to_email text not null,
  to_name text,
  status text not null check (status in ('sent', 'failed')),
  error text,
  message_id text,
  sent_by_auth_user_id uuid not null references auth.users(id) on delete restrict
);

create index if not exists send_logs_sent_at_idx
  on public.send_logs (sent_at desc);

create index if not exists send_logs_zip_account_idx
  on public.send_logs (zip_filename, account_key);

create index if not exists send_logs_account_trade_idx
  on public.send_logs (account_key, trade_date);

create index if not exists send_logs_to_email_idx
  on public.send_logs (to_email);

alter table public.send_logs enable row level security;

drop policy if exists send_logs_select_authenticated on public.send_logs;
create policy send_logs_select_authenticated
  on public.send_logs
  for select
  to authenticated
  using (true);

drop policy if exists send_logs_insert_authenticated on public.send_logs;
create policy send_logs_insert_authenticated
  on public.send_logs
  for insert
  to authenticated
  with check (true);
