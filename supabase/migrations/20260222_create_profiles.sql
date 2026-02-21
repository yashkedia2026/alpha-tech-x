create table if not exists public.profiles (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  user_id text unique not null,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_profiles_updated_at();

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = auth_user_id);

create or replace function public.handle_new_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_user_id text;
  generated_user_id text;
begin
  base_user_id := split_part(coalesce(new.email, ''), '@', 1);

  if base_user_id = '' then
    base_user_id := 'user_' || substring(new.id::text from 1 for 8);
  end if;

  generated_user_id := base_user_id;

  if exists (
    select 1 from public.profiles where user_id = generated_user_id
  ) then
    generated_user_id := base_user_id || '_' || substring(new.id::text from 1 for 8);
  end if;

  insert into public.profiles (auth_user_id, user_id, role)
  values (new.id, generated_user_id, 'user')
  on conflict (auth_user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row
execute function public.handle_new_auth_user_profile();
