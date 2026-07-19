-- Public workspace URLs are read-only capabilities at the application edge.
-- Keep the metadata tables private; the narrowly shaped resolver functions below
-- are the only anonymous database surface. This prevents a public table SELECT
-- from being mistaken for edit authorization by the workspace worker.

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx
  on public.workspace_members(user_id, workspace_id);

-- The raw capability is deliberately never persisted. A token is reusable and
-- non-expiring; revocation is represented without recording individual accepts.
create table public.workspace_share_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  token_hash text not null unique,
  shared_by uuid not null references auth.users(id) on delete restrict,
  can_edit boolean not null default true,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint workspace_share_tokens_token_hash_valid
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint workspace_share_tokens_edit_grant_only
    check (can_edit),
  constraint workspace_share_tokens_revocation_after_creation
    check (revoked_at is null or revoked_at >= created_at)
);

create index workspace_share_tokens_workspace_id_idx
  on public.workspace_share_tokens(workspace_id, created_at desc);

create index workspace_share_tokens_shared_by_idx
  on public.workspace_share_tokens(shared_by, created_at desc);

alter table public.workspace_members enable row level security;
alter table public.workspace_share_tokens enable row level security;

revoke all on public.workspace_members from anon, authenticated;
revoke all on public.workspace_share_tokens from anon, authenticated;

create or replace function private.is_workspace_member(
  target_workspace_id uuid,
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
    from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = target_user_id
  );
$$;

create or replace function private.can_access_workspace(
  target_workspace_id uuid,
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
    from public.workspaces workspace
    where workspace.id = target_workspace_id
      and workspace.deleted_at is null
      and (
        private.is_organization_member(workspace.organization_id, target_user_id)
        or private.is_workspace_member(workspace.id, target_user_id)
      )
  );
$$;

revoke all on function private.is_workspace_member(uuid, uuid) from public;
revoke all on function private.can_access_workspace(uuid, uuid) from public;
grant execute on function private.is_workspace_member(uuid, uuid) to authenticated;
grant execute on function private.can_access_workspace(uuid, uuid) to authenticated;

-- A direct workspace member may resolve the containing namespace through the
-- narrow RPCs below, but never receives broad organization-table reads.
drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member
on public.organizations for select to authenticated
using (
  (
    (select private.is_interactive_session())
    or (select private.is_lixray_mcp_session())
  )
  and (select private.is_organization_member(id))
);

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
on public.workspaces for select to authenticated
using (
  deleted_at is null
  and (
    (select private.is_interactive_session())
    or (select private.is_lixray_mcp_session())
  )
  and (select private.can_access_workspace(id))
);

drop policy if exists user_workspace_preferences_owner_member
  on public.user_workspace_preferences;
create policy user_workspace_preferences_owner_member
on public.user_workspace_preferences for all to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and (select private.can_access_workspace(workspace_id))
)
with check (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and (select private.can_access_workspace(workspace_id))
);

drop policy if exists user_workspace_review_resolutions_owner_member
  on public.user_workspace_review_resolutions;
create policy user_workspace_review_resolutions_owner_member
on public.user_workspace_review_resolutions for all to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and (select private.can_access_workspace(workspace_id))
)
with check (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and (select private.can_access_workspace(workspace_id))
);

-- Browser workspace-directory query: direct membership yields the one shared
-- workspace, whereas an organization member still receives every workspace in
-- that organization. The nullable organization_role explicitly distinguishes
-- the two cases without creating an organization-level grant.
create or replace function public.list_accessible_workspaces()
returns table (
  organization_id uuid,
  organization_name text,
  organization_handle text,
  organization_created_at timestamptz,
  organization_updated_at timestamptz,
  organization_role public.organization_role,
  workspace_id uuid,
  workspace_name text,
  workspace_slug text,
  workspace_created_at timestamptz,
  workspace_updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    organization.id,
    organization.name,
    organization.handle,
    organization.created_at,
    organization.updated_at,
    organization_member.role,
    workspace.id,
    workspace.name,
    workspace.slug,
    workspace.created_at,
    workspace.updated_at
  from public.workspaces workspace
  join public.organizations organization
    on organization.id = workspace.organization_id
  left join public.organization_members organization_member
    on organization_member.organization_id = workspace.organization_id
    and organization_member.user_id = auth.uid()
  where auth.uid() is not null
    and workspace.deleted_at is null
    and (
      organization_member.user_id is not null
      or exists (
        select 1
        from public.workspace_members workspace_member
        where workspace_member.workspace_id = workspace.id
          and workspace_member.user_id = auth.uid()
      )
    )
  order by organization.created_at asc, workspace.created_at asc;
$$;

-- These resolvers power globally readable canonical URLs. They expose only
-- live route metadata and never grant direct table access to anonymous callers.
create or replace function public.resolve_public_workspace(
  p_workspace_id uuid
)
returns table (
  organization_id uuid,
  organization_name text,
  organization_handle text,
  workspace_id uuid,
  workspace_name text,
  workspace_slug text,
  can_edit boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    organization.id,
    organization.name,
    organization.handle,
    workspace.id,
    workspace.name,
    workspace.slug,
    private.can_access_workspace(workspace.id, auth.uid())
  from public.workspaces workspace
  join public.organizations organization
    on organization.id = workspace.organization_id
  where workspace.id = p_workspace_id
    and workspace.deleted_at is null;
$$;

create or replace function public.resolve_public_workspace_by_route(
  p_organization_handle text,
  p_workspace_slug text
)
returns table (
  organization_id uuid,
  organization_name text,
  organization_handle text,
  workspace_id uuid,
  workspace_name text,
  workspace_slug text,
  can_edit boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    organization.id,
    organization.name,
    organization.handle,
    workspace.id,
    workspace.name,
    workspace.slug,
    private.can_access_workspace(workspace.id, auth.uid())
  from public.workspaces workspace
  join public.organizations organization
    on organization.id = workspace.organization_id
  where organization.handle = lower(btrim(coalesce(p_organization_handle, '')))
    and workspace.slug = lower(btrim(coalesce(p_workspace_slug, '')))
    and workspace.deleted_at is null;
$$;

create or replace function public.resolve_workspace_share_token(p_token text)
returns table (
  organization_id uuid,
  organization_name text,
  organization_handle text,
  workspace_id uuid,
  workspace_name text,
  workspace_slug text,
  shared_by_name text,
  shared_by_avatar_url text,
  can_edit boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    organization.id,
    organization.name,
    organization.handle,
    workspace.id,
    workspace.name,
    workspace.slug,
    profile.name,
    profile.avatar_url,
    share_token.can_edit
  from public.workspace_share_tokens share_token
  join public.workspaces workspace
    on workspace.id = share_token.workspace_id
  join public.organizations organization
    on organization.id = workspace.organization_id
  left join public.profiles profile
    on profile.id = share_token.shared_by
  where share_token.token_hash = encode(
      extensions.digest(coalesce(p_token, ''), 'sha256'),
      'hex'
    )
    and share_token.revoked_at is null
    and share_token.can_edit
    and workspace.deleted_at is null;
$$;

create or replace function public.create_workspace_share_token(
  p_workspace_id uuid
)
returns table (token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  -- Nano-ID-style token: 21 chars from a 64-symbol URL alphabet (~126 bits
  -- of entropy) keeps share links friendly. 256 % 64 = 0, so masking each
  -- random byte introduces no modulo bias.
  token_alphabet constant text :=
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  token_bytes bytea := extensions.gen_random_bytes(21);
  raw_token text := '';
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  for i in 0..20 loop
    raw_token := raw_token
      || substr(token_alphabet, (get_byte(token_bytes, i) & 63) + 1, 1);
  end loop;
  if not private.is_interactive_session() then
    raise exception 'Interactive session required';
  end if;
  if not private.can_access_workspace(p_workspace_id, current_user_id) then
    raise exception 'Workspace edit access required';
  end if;

  insert into public.workspace_share_tokens (
    workspace_id,
    token_hash,
    shared_by,
    can_edit
  ) values (
    p_workspace_id,
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    current_user_id,
    true
  );

  return query select raw_token;
end;
$$;

-- Share acceptance deliberately provisions a personal namespace, never the
-- email-domain workspace. That keeps a corporate-email recipient's grant
-- scoped to this one workspace even when its host organization has a matching
-- email_domain identity.
create or replace function private.ensure_personal_workspace_only()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  profile_record public.profiles%rowtype;
  base_handle text;
  candidate_handle text;
  target_organization_id uuid;
  created_workspace boolean := false;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('personal-workspace:' || current_user_id::text, 0)
  );

  select * into profile_record
  from public.profiles
  where id = current_user_id;

  if profile_record.id is null then
    raise exception 'Profile not found';
  end if;

  select id into target_organization_id
  from public.organizations
  where personal_owner_id = current_user_id;

  if target_organization_id is null then
    base_handle := coalesce(
      nullif(private.url_segment(split_part(profile_record.email, '@', 1), 39), ''),
      nullif(private.url_segment(profile_record.name, 39), ''),
      'user'
    );
    candidate_handle := base_handle;

    perform pg_advisory_xact_lock(
      hashtextextended('organization-handle:' || replace(base_handle, '-', ''), 0)
    );

    if exists (
      select 1 from public.organizations
      where replace(handle, '-', '') = replace(candidate_handle, '-', '')
    ) then
      candidate_handle := left(base_handle, 26) || '-' ||
        left(replace(current_user_id::text, '-', ''), 12);
    end if;

    insert into public.organizations (name, handle, personal_owner_id)
    values (profile_record.name, candidate_handle, current_user_id)
    returning id into target_organization_id;

    insert into public.organization_members (organization_id, user_id, role)
    values (target_organization_id, current_user_id, 'owner');
  end if;

  if not exists (
    select 1 from public.workspaces
    where organization_id = target_organization_id and deleted_at is null
  ) then
    insert into public.workspaces (organization_id, name)
    values (target_organization_id, 'My workspace');
    created_workspace := true;
  end if;

  return created_workspace;
end;
$$;

create or replace function public.ensure_personal_workspace_only()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.ensure_personal_workspace_only();
$$;

create or replace function public.accept_workspace_share_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target_workspace_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if not private.is_interactive_session() then
    raise exception 'Interactive session required';
  end if;

  select share_token.workspace_id into target_workspace_id
  from public.workspace_share_tokens share_token
  join public.workspaces workspace
    on workspace.id = share_token.workspace_id
  where share_token.token_hash = encode(
      extensions.digest(coalesce(p_token, ''), 'sha256'),
      'hex'
    )
    and share_token.revoked_at is null
    and share_token.can_edit
    and workspace.deleted_at is null
  for update of share_token;

  if target_workspace_id is null then
    raise exception 'Workspace share link is invalid or revoked';
  end if;

  -- A fresh Google account receives a personal namespace without an onboarding
  -- detour or email-domain organization enrollment before joining.
  perform public.ensure_personal_workspace_only();

  insert into public.workspace_members (workspace_id, user_id)
  values (target_workspace_id, current_user_id)
  on conflict (workspace_id, user_id) do nothing;

  return target_workspace_id;
end;
$$;

-- There is intentionally no UI or token list yet. This RPC makes a leaked
-- capability revocable without forcing it to expire or tracking accepts.
create or replace function public.revoke_workspace_share_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target_workspace_id uuid;
  token_sharer_id uuid;
  target_organization_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if not private.is_interactive_session() then
    raise exception 'Interactive session required';
  end if;

  select
    share_token.workspace_id,
    share_token.shared_by,
    workspace.organization_id
  into
    target_workspace_id,
    token_sharer_id,
    target_organization_id
  from public.workspace_share_tokens share_token
  join public.workspaces workspace
    on workspace.id = share_token.workspace_id
  where share_token.token_hash = encode(
      extensions.digest(coalesce(p_token, ''), 'sha256'),
      'hex'
    )
    and share_token.revoked_at is null
  for update of share_token;

  if target_workspace_id is null
    or (
      token_sharer_id <> current_user_id
      and not private.is_organization_owner(target_organization_id, current_user_id)
    ) then
    raise exception 'Active workspace share link not found';
  end if;

  update public.workspace_share_tokens
  set revoked_at = now()
  where workspace_id = target_workspace_id
    and token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and revoked_at is null;
end;
$$;

revoke all on function public.list_accessible_workspaces() from public, anon;
revoke all on function public.resolve_public_workspace(uuid) from public;
revoke all on function public.resolve_public_workspace_by_route(text, text) from public;
revoke all on function public.resolve_workspace_share_token(text) from public;
revoke all on function public.create_workspace_share_token(uuid) from public, anon;
revoke all on function public.accept_workspace_share_token(text) from public, anon;
revoke all on function public.revoke_workspace_share_token(text) from public, anon;
revoke all on function private.ensure_personal_workspace_only() from public;
revoke all on function public.ensure_personal_workspace_only() from public, anon;

grant execute on function public.list_accessible_workspaces() to authenticated;
grant execute on function public.resolve_public_workspace(uuid) to anon, authenticated;
grant execute on function public.resolve_public_workspace_by_route(text, text)
  to anon, authenticated;
grant execute on function public.resolve_workspace_share_token(text)
  to anon, authenticated;
grant execute on function public.create_workspace_share_token(uuid) to authenticated;
grant execute on function public.accept_workspace_share_token(text) to authenticated;
grant execute on function public.revoke_workspace_share_token(text) to authenticated;
grant execute on function public.ensure_personal_workspace_only() to authenticated;

create trigger workspace_members_reject_lixray_mcp_mutation
before insert or update or delete on public.workspace_members
for each row execute function private.reject_lixray_mcp_management_mutation();

create trigger workspace_share_tokens_reject_lixray_mcp_mutation
before insert or update or delete on public.workspace_share_tokens
for each row execute function private.reject_lixray_mcp_management_mutation();
