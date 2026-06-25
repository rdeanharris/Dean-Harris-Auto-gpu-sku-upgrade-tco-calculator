-- GPU TCO secure login and named configuration storage.
-- Run this in your Supabase SQL editor, then update gpu_tco_auth_config.js
-- with the project URL and public anon key.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tco_configurations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  app_id text not null,
  name text not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(name)) between 1 and 120)
);

create table if not exists public.tco_user_invites (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'gpu-tco-june-22',
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (position('@' in email) > 1)
);

create unique index if not exists tco_configurations_owner_app_name_uidx
  on public.tco_configurations (owner_id, app_id, lower(name));

create unique index if not exists tco_user_invites_app_email_active_uidx
  on public.tco_user_invites (app_id, lower(email))
  where revoked_at is null;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists tco_configurations_touch_updated_at on public.tco_configurations;
create trigger tco_configurations_touch_updated_at
before update on public.tco_configurations
for each row execute function public.touch_updated_at();

drop trigger if exists tco_user_invites_touch_updated_at on public.tco_user_invites;
create trigger tco_user_invites_touch_updated_at
before update on public.tco_user_invites
for each row execute function public.touch_updated_at();

create or replace function public.is_gpu_tco_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.gpu_tco_invite_role(invite_email text, invite_app_id text default 'gpu-tco-june-22')
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.tco_user_invites
  where app_id = invite_app_id
    and lower(email) = lower(invite_email)
    and revoked_at is null
  order by created_at desc
  limit 1;
$$;

create or replace function public.handle_gpu_tco_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(coalesce(new.email, ''));
  invite_role text;
  assigned_role text;
begin
  invite_role := public.gpu_tco_invite_role(normalized_email, 'gpu-tco-june-22');

  if normalized_email = '' or (right(normalized_email, 11) <> '@nvidia.com' and invite_role is null) then
    raise exception 'GPU TCO access requires an @nvidia.com email address or an active external invite';
  end if;

  assigned_role := case
    -- Add more administrator aliases here as needed.
    when normalized_email in ('deanh@nvidia.com') then 'admin'
    when invite_role = 'admin' then 'admin'
    else 'user'
  end;

  insert into public.profiles (id, email, role)
  values (
    new.id,
    normalized_email,
    assigned_role
  )
  on conflict (id) do update
    set email = excluded.email,
        role = case
          when public.profiles.role = 'admin' then 'admin'
          when assigned_role = 'admin' then 'admin'
          else public.profiles.role
        end,
        updated_at = now();

  if invite_role is not null then
    update public.tco_user_invites
    set accepted_by = new.id,
        accepted_at = coalesce(accepted_at, now()),
        updated_at = now()
    where app_id = 'gpu-tco-june-22'
      and lower(email) = normalized_email
      and revoked_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_gpu_tco_profile on auth.users;
create trigger on_auth_user_gpu_tco_profile
after insert or update of email on auth.users
for each row execute function public.handle_gpu_tco_user_profile();

alter table public.profiles enable row level security;
alter table public.tco_configurations enable row level security;
alter table public.tco_user_invites enable row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin
on public.profiles
for select
using (auth.uid() = id or public.is_gpu_tco_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
on public.profiles
for update
using (public.is_gpu_tco_admin())
with check (public.is_gpu_tco_admin());

drop policy if exists tco_configurations_select_owner_or_admin on public.tco_configurations;
create policy tco_configurations_select_owner_or_admin
on public.tco_configurations
for select
using (auth.uid() = owner_id or public.is_gpu_tco_admin());

drop policy if exists tco_configurations_insert_owner on public.tco_configurations;
create policy tco_configurations_insert_owner
on public.tco_configurations
for insert
with check (auth.uid() = owner_id);

drop policy if exists tco_configurations_update_owner_or_admin on public.tco_configurations;
create policy tco_configurations_update_owner_or_admin
on public.tco_configurations
for update
using (auth.uid() = owner_id or public.is_gpu_tco_admin())
with check (auth.uid() = owner_id or public.is_gpu_tco_admin());

drop policy if exists tco_configurations_delete_owner_or_admin on public.tco_configurations;
create policy tco_configurations_delete_owner_or_admin
on public.tco_configurations
for delete
using (auth.uid() = owner_id or public.is_gpu_tco_admin());

drop policy if exists tco_user_invites_select_admin on public.tco_user_invites;
create policy tco_user_invites_select_admin
on public.tco_user_invites
for select
using (public.is_gpu_tco_admin());

drop policy if exists tco_user_invites_insert_admin on public.tco_user_invites;
create policy tco_user_invites_insert_admin
on public.tco_user_invites
for insert
with check (public.is_gpu_tco_admin());

drop policy if exists tco_user_invites_update_admin on public.tco_user_invites;
create policy tco_user_invites_update_admin
on public.tco_user_invites
for update
using (public.is_gpu_tco_admin())
with check (public.is_gpu_tco_admin());

drop policy if exists tco_user_invites_delete_admin on public.tco_user_invites;
create policy tco_user_invites_delete_admin
on public.tco_user_invites
for delete
using (public.is_gpu_tco_admin());
