-- The RETURNS TABLE output column `namespace_id` is also a PL/pgSQL variable.
-- Naming the primary-key columns in ON CONFLICT therefore raises 42702 before
-- an invitee can be inserted. Target the constraint instead.
create or replace function public.accept_namespace_invite(p_token text)
returns table(namespace_id uuid, namespace_name text, namespace_handle text)
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_user_id uuid := auth.uid();
	target_namespace_id uuid;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select link.namespace_id into target_namespace_id
	from public.namespace_invite_links link
	where link.token = coalesce(p_token, '');
	if target_namespace_id is null then raise exception 'Invalid or reset invite link'; end if;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (target_namespace_id, current_user_id, 'member')
	on conflict on constraint namespace_members_pkey do nothing;
	return query
	select namespace.id, namespace.name, handle.handle
	from public.namespaces namespace
	join public.handles handle on handle.namespace_id = namespace.id
	where namespace.id = target_namespace_id;
end;
$$;
