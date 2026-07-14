create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
  if coalesce(claims ->> 'client_id', '') <> '' then
    claims := jsonb_set(
      claims,
      '{resource}',
      to_jsonb('https://lixray.com'::text),
      true
    );
    claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

revoke all on function private.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;

create or replace function private.is_lixray_mcp_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'lixray_mcp')::boolean, false)
    and (select auth.jwt() ->> 'resource') = 'https://lixray.com'
    and nullif((select auth.jwt() ->> 'client_id'), '') is not null;
$$;

create or replace function private.is_interactive_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select nullif((select auth.jwt() ->> 'client_id'), '') is null;
$$;

grant execute on function private.is_lixray_mcp_session() to authenticated;
grant execute on function private.is_interactive_session() to authenticated;

drop policy if exists profiles_select_shared_organization on public.profiles;
create policy profiles_select_shared_organization
on public.profiles for select to authenticated
using (
  (select private.is_interactive_session())
  and (
    id = (select auth.uid())
    or (select private.users_share_organization((select auth.uid()), id))
  )
);

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

drop policy if exists organization_members_select_member on public.organization_members;
create policy organization_members_select_member
on public.organization_members for select to authenticated
using (
  (select private.is_interactive_session())
  and (select private.is_organization_member(organization_id))
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

drop policy if exists organization_invitations_select_owner on public.organization_invitations;
create policy organization_invitations_select_owner
on public.organization_invitations for select to authenticated
using (
  (select private.is_interactive_session())
  and (select private.is_organization_owner(organization_id))
);

create or replace function private.reject_lixray_mcp_management_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_lixray_mcp_session() then
    raise exception 'LixRay MCP tokens cannot modify account or workspace metadata';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.reject_lixray_mcp_management_mutation() from public, anon, authenticated;

create trigger profiles_reject_lixray_mcp_mutation
before insert or update or delete on public.profiles
for each row execute function private.reject_lixray_mcp_management_mutation();

create trigger organizations_reject_lixray_mcp_mutation
before insert or update or delete on public.organizations
for each row execute function private.reject_lixray_mcp_management_mutation();

create trigger organization_members_reject_lixray_mcp_mutation
before insert or update or delete on public.organization_members
for each row execute function private.reject_lixray_mcp_management_mutation();

create trigger workspaces_reject_lixray_mcp_mutation
before insert or update or delete on public.workspaces
for each row execute function private.reject_lixray_mcp_management_mutation();

create trigger organization_invitations_reject_lixray_mcp_mutation
before insert or update or delete on public.organization_invitations
for each row execute function private.reject_lixray_mcp_management_mutation();

create or replace function public.delete_workspace(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
begin
  if not private.is_interactive_session() then
    if private.is_lixray_mcp_session() then
      raise exception 'LixRay MCP tokens cannot modify account or workspace metadata';
    end if;
    raise exception 'Interactive session required';
  end if;

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
