-- Direct repository members for the repository settings page.
--
-- lix_members holds people who joined one repository through a share link
-- (as opposed to namespace membership, which covers every repository in the
-- account). The settings page lists them with profile details and lets an
-- owner remove them - or a member leave - mirroring the namespace RPCs.

create or replace function public.list_lix_members(p_lix_id uuid)
returns table(
	user_id uuid,
	name text,
	email text,
	avatar_url text,
	role public.namespace_role,
	joined_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
	select member.user_id, profile.name, profile.email, profile.avatar_url,
		member.role, member.created_at
	from public.lix_members member
	join public.profiles profile on profile.id = member.user_id
	where member.lix_id = p_lix_id
		and private.is_interactive_session()
		and private.can_access_lix(p_lix_id, auth.uid())
	order by member.created_at asc, profile.name asc;
$$;

revoke all on function public.list_lix_members(uuid) from public;
grant all on function public.list_lix_members(uuid) to authenticated;

create or replace function public.remove_lix_member(p_lix_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	owning_namespace_id uuid;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select namespace_id into owning_namespace_id from public.lixes where id = p_lix_id;
	if owning_namespace_id is null then raise exception 'Repository not found'; end if;
	-- Members may remove themselves; anything else requires owning-namespace
	-- ownership.
	if p_user_id <> current_user_id
		and not private.is_namespace_owner(owning_namespace_id, current_user_id) then
		raise exception 'Namespace owner access required';
	end if;
	delete from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
end;
$$;

revoke all on function public.remove_lix_member(uuid, uuid) from public;
grant all on function public.remove_lix_member(uuid, uuid) to authenticated;
