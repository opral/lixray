-- PostgREST may evaluate the SELECT policy for INSERT ... RETURNING before
-- the AFTER INSERT membership-seeding trigger has run. Let namespace members
-- see only that transient, still-unseeded row. Once memberships exist, normal
-- repository membership is the sole private-repository authorization source.

create or replace function private.can_access_lix_or_unseeded(
	target_lix_id uuid,
	target_namespace_id uuid,
	target_user_id uuid default auth.uid()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select private.can_access_lix(target_lix_id, target_user_id)
		or (
			not exists (
				select 1 from public.lix_members member
				where member.lix_id = target_lix_id
			)
			and private.is_namespace_member(target_namespace_id, target_user_id)
		);
$$;

drop policy lixes_select_accessible on public.lixes;
create policy lixes_select_accessible
	on public.lixes for select to authenticated
	using (private.can_access_lix_or_unseeded(id, namespace_id));

revoke all on function private.can_access_lix_or_unseeded(uuid, uuid, uuid) from public;
grant execute on function private.can_access_lix_or_unseeded(uuid, uuid, uuid) to authenticated;
