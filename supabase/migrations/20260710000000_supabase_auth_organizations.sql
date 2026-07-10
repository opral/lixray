create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

create type public.organization_role as enum ('owner', 'member');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_normalized check (email = lower(btrim(email))),
  constraint profiles_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 80
  )
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 80
  )
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_user_id_idx
  on public.organization_members(user_id, organization_id);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 80
  )
);

create unique index workspaces_organization_name_unique
  on public.workspaces(organization_id, lower(name));

create index workspaces_organization_id_idx
  on public.workspaces(organization_id);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint organization_invitations_email_normalized
    check (email = lower(btrim(email))),
  constraint organization_invitations_token_hash_valid
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint organization_invitations_state_valid check (
    not (accepted_at is not null and revoked_at is not null)
    and ((accepted_at is null and accepted_by is null)
      or (accepted_at is not null and accepted_by is not null))
  )
);

create unique index organization_invitations_pending_email_unique
  on public.organization_invitations(organization_id, email)
  where accepted_at is null and revoked_at is null;

create index organization_invitations_organization_id_idx
  on public.organization_invitations(organization_id, created_at desc);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function private.set_updated_at();

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function private.set_updated_at();

create or replace function private.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_name text;
begin
  profile_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'User'
  );

  insert into public.profiles (id, email, name, avatar_url)
  values (
    new.id,
    lower(btrim(coalesce(new.email, ''))),
    left(profile_name, 80),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
      nullif(new.raw_user_meta_data ->> 'picture', '')
    )
  )
  on conflict (id) do update
  set email = excluded.email,
      name = excluded.name,
      avatar_url = excluded.avatar_url;

  return new;
end;
$$;

create trigger auth_user_profile_sync
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function private.sync_auth_user_profile();

insert into public.profiles (id, email, name, avatar_url)
select
  id,
  lower(btrim(email)),
  left(coalesce(
    nullif(btrim(raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(raw_user_meta_data ->> 'name'), ''),
    split_part(email, '@', 1),
    'User'
  ), 80),
  coalesce(
    nullif(raw_user_meta_data ->> 'avatar_url', ''),
    nullif(raw_user_meta_data ->> 'picture', '')
  )
from auth.users
where email is not null and btrim(email) <> ''
on conflict (id) do nothing;

create or replace function private.is_organization_member(
  target_organization_id uuid,
  target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = target_organization_id
      and user_id = target_user_id
  );
$$;

create or replace function private.is_organization_owner(
  target_organization_id uuid,
  target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = target_organization_id
      and user_id = target_user_id
      and role = 'owner'
  );
$$;

create or replace function private.users_share_organization(
  first_user_id uuid,
  second_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members first_member
    join public.organization_members second_member
      on second_member.organization_id = first_member.organization_id
    where first_member.user_id = first_user_id
      and second_member.user_id = second_user_id
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_organization_member(uuid, uuid) to authenticated;
grant execute on function private.is_organization_owner(uuid, uuid) to authenticated;
grant execute on function private.users_share_organization(uuid, uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.workspaces enable row level security;
alter table public.organization_invitations enable row level security;

create policy profiles_select_shared_organization
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or (select private.users_share_organization((select auth.uid()), id))
);

create policy organizations_select_member
on public.organizations for select to authenticated
using ((select private.is_organization_member(id)));

create policy organization_members_select_member
on public.organization_members for select to authenticated
using ((select private.is_organization_member(organization_id)));

create policy workspaces_select_member
on public.workspaces for select to authenticated
using ((select private.is_organization_member(organization_id)));

create policy workspaces_insert_member
on public.workspaces for insert to authenticated
with check ((select private.is_organization_member(organization_id)));

create policy workspaces_update_member
on public.workspaces for update to authenticated
using ((select private.is_organization_member(organization_id)))
with check ((select private.is_organization_member(organization_id)));

create policy organization_invitations_select_owner
on public.organization_invitations for select to authenticated
using ((select private.is_organization_owner(organization_id)));

revoke all on public.profiles from anon, authenticated;
revoke all on public.organizations from anon, authenticated;
revoke all on public.organization_members from anon, authenticated;
revoke all on public.workspaces from anon, authenticated;
revoke all on public.organization_invitations from anon, authenticated;

grant select on public.profiles to authenticated;
grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select, insert on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select on public.organization_invitations to authenticated;

create or replace function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_name text := btrim(coalesce(p_name, ''));
  new_organization_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if char_length(normalized_name) not between 1 and 80 then
    raise exception 'Organization name must be between 1 and 80 characters';
  end if;

  insert into public.organizations (name)
  values (normalized_name)
  returning id into new_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (new_organization_id, current_user_id, 'owner');

  return new_organization_id;
end;
$$;

create or replace function public.rename_organization(
  p_organization_id uuid,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := btrim(coalesce(p_name, ''));
begin
  if not private.is_organization_owner(p_organization_id, auth.uid()) then
    raise exception 'Organization owner access required';
  end if;
  if char_length(normalized_name) not between 1 and 80 then
    raise exception 'Organization name must be between 1 and 80 characters';
  end if;

  update public.organizations
  set name = normalized_name
  where id = p_organization_id;
end;
$$;

create or replace function public.create_organization_invitation(
  p_organization_id uuid,
  p_email text
)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_email text := lower(btrim(coalesce(p_email, '')));
  raw_token text := encode(extensions.gen_random_bytes(32), 'hex');
  token_expiry timestamptz := now() + interval '7 days';
begin
  if not private.is_organization_owner(p_organization_id, current_user_id) then
    raise exception 'Organization owner access required';
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid email address is required';
  end if;
  if exists (
    select 1
    from public.organization_members member
    join auth.users invited_user on invited_user.id = member.user_id
    where member.organization_id = p_organization_id
      and lower(btrim(invited_user.email)) = normalized_email
  ) then
    raise exception 'That user is already an organization member';
  end if;

  insert into public.organization_invitations (
    organization_id,
    email,
    token_hash,
    invited_by,
    expires_at
  ) values (
    p_organization_id,
    normalized_email,
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    current_user_id,
    token_expiry
  )
  on conflict (organization_id, email)
    where accepted_at is null and revoked_at is null
  do update set
    token_hash = excluded.token_hash,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    created_at = now();

  return query select raw_token, token_expiry;
end;
$$;

create or replace function public.revoke_organization_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
begin
  select organization_id into target_organization_id
  from public.organization_invitations
  where id = p_invitation_id and accepted_at is null and revoked_at is null;

  if target_organization_id is null
    or not private.is_organization_owner(target_organization_id, auth.uid()) then
    raise exception 'Active invitation not found';
  end if;

  update public.organization_invitations
  set revoked_at = now()
  where id = p_invitation_id;
end;
$$;

create or replace function public.accept_organization_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_email text;
  invitation public.organization_invitations%rowtype;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select lower(btrim(email)) into current_email
  from auth.users
  where id = current_user_id;

  select * into invitation
  from public.organization_invitations
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and accepted_at is null
    and revoked_at is null
    and expires_at > now()
  for update;

  if invitation.id is null then
    raise exception 'Invitation is invalid or expired';
  end if;
  if current_email is null or current_email <> invitation.email then
    raise exception 'Sign in with the Google account that was invited';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (invitation.organization_id, current_user_id, 'member')
  on conflict (organization_id, user_id) do nothing;

  update public.organization_invitations
  set accepted_at = now(), accepted_by = current_user_id
  where id = invitation.id;

  return invitation.organization_id;
end;
$$;

create or replace function public.set_organization_member_role(
  p_organization_id uuid,
  p_user_id uuid,
  p_role public.organization_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_role public.organization_role;
begin
  if not private.is_organization_owner(p_organization_id, auth.uid()) then
    raise exception 'Organization owner access required';
  end if;

  select role into existing_role
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id
  for update;

  if existing_role is null then
    raise exception 'Organization member not found';
  end if;
  if existing_role = 'owner' and p_role = 'member' and (
    select count(*) from public.organization_members
    where organization_id = p_organization_id and role = 'owner'
  ) <= 1 then
    raise exception 'An organization must have at least one owner';
  end if;

  update public.organization_members
  set role = p_role
  where organization_id = p_organization_id and user_id = p_user_id;
end;
$$;

create or replace function public.remove_organization_member(
  p_organization_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_role public.organization_role;
begin
  if not private.is_organization_owner(p_organization_id, auth.uid()) then
    raise exception 'Organization owner access required';
  end if;

  select role into existing_role
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id
  for update;

  if existing_role is null then
    raise exception 'Organization member not found';
  end if;
  if existing_role = 'owner' and (
    select count(*) from public.organization_members
    where organization_id = p_organization_id and role = 'owner'
  ) <= 1 then
    raise exception 'An organization must have at least one owner';
  end if;

  delete from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id;
end;
$$;

create or replace function public.leave_organization(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  existing_role public.organization_role;
begin
  select role into existing_role
  from public.organization_members
  where organization_id = p_organization_id and user_id = current_user_id
  for update;

  if existing_role is null then
    raise exception 'Organization membership not found';
  end if;
  if existing_role = 'owner' and (
    select count(*) from public.organization_members
    where organization_id = p_organization_id and role = 'owner'
  ) <= 1 then
    raise exception 'Promote another owner before leaving';
  end if;

  delete from public.organization_members
  where organization_id = p_organization_id and user_id = current_user_id;
end;
$$;

revoke all on function public.create_organization(text) from public, anon;
revoke all on function public.rename_organization(uuid, text) from public, anon;
revoke all on function public.create_organization_invitation(uuid, text) from public, anon;
revoke all on function public.revoke_organization_invitation(uuid) from public, anon;
revoke all on function public.accept_organization_invitation(text) from public, anon;
revoke all on function public.set_organization_member_role(uuid, uuid, public.organization_role) from public, anon;
revoke all on function public.remove_organization_member(uuid, uuid) from public, anon;
revoke all on function public.leave_organization(uuid) from public, anon;

grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.rename_organization(uuid, text) to authenticated;
grant execute on function public.create_organization_invitation(uuid, text) to authenticated;
grant execute on function public.revoke_organization_invitation(uuid) to authenticated;
grant execute on function public.accept_organization_invitation(text) to authenticated;
grant execute on function public.set_organization_member_role(uuid, uuid, public.organization_role) to authenticated;
grant execute on function public.remove_organization_member(uuid, uuid) to authenticated;
grant execute on function public.leave_organization(uuid) to authenticated;
