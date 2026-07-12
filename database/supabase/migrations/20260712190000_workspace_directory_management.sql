create or replace function private.url_segment(source text, max_length integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(both '-' from left(
    trim(both '-' from regexp_replace(lower(coalesce(source, '')), '[^a-z0-9]+', '-', 'g')),
    max_length
  ));
$$;

alter table public.organizations add column if not exists handle text;
alter table public.workspaces add column if not exists slug text;

with candidates as (
  select
    id,
    coalesce(nullif(private.url_segment(name, 39), ''), 'namespace') as base,
    row_number() over (
      partition by replace(coalesce(nullif(private.url_segment(name, 39), ''), 'namespace'), '-', '')
      order by created_at, id
    ) as occurrence
  from public.organizations
)
update public.organizations organization
set handle = case
  when candidates.occurrence = 1 then candidates.base
  else left(candidates.base, 32) || '-' || left(replace(organization.id::text, '-', ''), 6)
end
from candidates
where candidates.id = organization.id and organization.handle is null;

with candidates as (
  select
    id,
    organization_id,
    coalesce(nullif(private.url_segment(name, 100), ''), 'workspace') as base,
    row_number() over (
      partition by organization_id, replace(coalesce(nullif(private.url_segment(name, 100), ''), 'workspace'), '-', '')
      order by created_at, id
    ) as occurrence
  from public.workspaces
)
update public.workspaces workspace
set slug = case
  when candidates.occurrence = 1 then candidates.base
  else left(candidates.base, 93) || '-' || left(replace(workspace.id::text, '-', ''), 6)
end
from candidates
where candidates.id = workspace.id and workspace.slug is null;

alter table public.organizations
  alter column handle set not null,
  add constraint organizations_handle_valid check (
    handle ~ '^[a-z0-9](?:-?[a-z0-9]){0,38}$' and char_length(handle) <= 39
  );

alter table public.workspaces
  alter column slug set not null,
  add constraint workspaces_slug_valid check (
    slug ~ '^[a-z0-9](?:-?[a-z0-9]){0,99}$' and char_length(slug) <= 100
  );

create unique index if not exists organizations_handle_unique
  on public.organizations(handle);
create unique index if not exists organizations_handle_squat_unique
  on public.organizations(replace(handle, '-', ''));
create unique index if not exists workspaces_organization_slug_unique
  on public.workspaces(organization_id, slug);
create unique index if not exists workspaces_organization_slug_squat_unique
  on public.workspaces(organization_id, replace(slug, '-', ''));

create or replace function private.assign_organization_handle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  base text := coalesce(nullif(private.url_segment(new.name, 39), ''), 'namespace');
begin
  if new.handle is null or btrim(new.handle) = '' then
    new.handle := base;
    if exists (
      select 1 from public.organizations
      where replace(handle, '-', '') = replace(new.handle, '-', '')
    ) then
      new.handle := left(base, 32) || '-' || left(replace(new.id::text, '-', ''), 6);
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.assign_workspace_slug()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  base text := coalesce(nullif(private.url_segment(new.name, 100), ''), 'workspace');
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := base;
    if exists (
      select 1 from public.workspaces
      where organization_id = new.organization_id
        and replace(slug, '-', '') = replace(new.slug, '-', '')
    ) then
      new.slug := left(base, 93) || '-' || left(replace(new.id::text, '-', ''), 6);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_assign_handle on public.organizations;
create trigger organizations_assign_handle
before insert on public.organizations
for each row execute function private.assign_organization_handle();

drop trigger if exists workspaces_assign_slug on public.workspaces;
create trigger workspaces_assign_slug
before insert on public.workspaces
for each row execute function private.assign_workspace_slug();

alter table public.workspaces
  add column if not exists deleted_at timestamptz;

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
on public.workspaces for select to authenticated
using (
  deleted_at is null
  and (
    (select private.is_interactive_session())
    or (select private.is_lixray_mcp_session())
  )
  and (select private.is_organization_member(organization_id))
);

drop policy if exists workspaces_insert_member on public.workspaces;
create policy workspaces_insert_member
on public.workspaces for insert to authenticated
with check (
  deleted_at is null
  and (select private.is_interactive_session())
  and (select private.is_organization_member(organization_id))
);

drop policy if exists workspaces_update_member on public.workspaces;
create policy workspaces_update_member
on public.workspaces for update to authenticated
using (
  deleted_at is null
  and (select private.is_interactive_session())
  and (select private.is_organization_member(organization_id))
)
with check (
  deleted_at is null
  and (select private.is_interactive_session())
  and (select private.is_organization_member(organization_id))
);

create or replace function public.delete_workspace(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
begin
  select organization_id into target_organization_id
  from public.workspaces
  where id = p_workspace_id and deleted_at is null;

  if target_organization_id is null
    or not private.is_organization_member(target_organization_id, auth.uid()) then
    raise exception 'Workspace not found';
  end if;

  update public.workspaces
  set deleted_at = now()
  where id = p_workspace_id and deleted_at is null;
end;
$$;

revoke all on function public.delete_workspace(uuid) from public;
grant execute on function public.delete_workspace(uuid) to authenticated;
