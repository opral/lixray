-- Repository admins are a monotonic role in the first control-plane model.
-- A member may be promoted, but an admin cannot be demoted, removed, or leave.

create or replace function public.set_lix_member_role(
	p_lix_id uuid,
	p_user_id uuid,
	p_role public.lix_role
)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare
	existing_role public.lix_role;
begin
	if auth.uid() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_lix_admin(p_lix_id, auth.uid()) then
		raise exception 'Repository admin access required';
	end if;
	select role into existing_role from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
	if existing_role is null then raise exception 'Repository member not found'; end if;
	if existing_role = 'admin' and p_role = 'member' then
		raise exception 'Repository admins cannot be demoted';
	end if;
	update public.lix_members set role = p_role
	where lix_id = p_lix_id and user_id = p_user_id;
end;
$$;

create or replace function public.remove_lix_member(p_lix_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	target_role public.lix_role;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if p_user_id <> current_user_id
		and not private.is_lix_admin(p_lix_id, current_user_id) then
		raise exception 'Repository admin access required';
	end if;
	select role into target_role from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
	if target_role is null then raise exception 'Repository member not found'; end if;
	if target_role = 'admin' then
		raise exception 'Repository admins cannot leave or be removed';
	end if;
	delete from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
end;
$$;
