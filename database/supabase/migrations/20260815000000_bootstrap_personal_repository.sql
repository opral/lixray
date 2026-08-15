-- Give every newly created personal namespace its first repository.
-- Existing namespaces keep their current repository set, including an empty
-- set after the user deletes the default repository.
create or replace function public.bootstrap_personal_namespace()
returns table(
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_user_id uuid := auth.uid();
	profile_record public.profiles%rowtype;
	existing_namespace_id uuid;
	created_namespace_id uuid;
	created_lix_id uuid;
	claimed_handle text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;

	perform pg_advisory_xact_lock(hashtextextended('personal-namespace:' || current_user_id::text, 0));
	select primary_namespace.namespace_id into existing_namespace_id
	from public.user_primary_namespaces primary_namespace
	where primary_namespace.user_id = current_user_id;

	if existing_namespace_id is not null then
		return query
		select namespace.id, namespace.name, handle.handle,
			lix.id, lix.name, lix.slug, false
		from public.namespaces namespace
		join public.handles handle on handle.namespace_id = namespace.id
		left join lateral (
			select candidate.id, candidate.name, candidate.slug
			from public.lixes candidate
			where candidate.namespace_id = namespace.id and candidate.deleted_at is null
			order by candidate.created_at asc
			limit 1
		) lix on true
		where namespace.id = existing_namespace_id;
		return;
	end if;

	select * into profile_record from public.profiles where id = current_user_id;
	if profile_record.id is null then raise exception 'Profile not found'; end if;

	claimed_handle := private.unique_handle(
		coalesce(nullif(split_part(profile_record.email, '@', 1), ''), profile_record.name),
		current_user_id
	);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));

	insert into public.namespaces (kind, name)
	values ('personal', profile_record.name)
	returning id into created_namespace_id;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (created_namespace_id, current_user_id, 'owner');
	insert into public.user_primary_namespaces (user_id, namespace_id)
	values (current_user_id, created_namespace_id);
	insert into public.handles (handle, namespace_id)
	values (claimed_handle, created_namespace_id);
	insert into public.lixes (namespace_id, name, slug)
	values (created_namespace_id, 'repository', 'repository')
	returning id into created_lix_id;

	return query select created_namespace_id, profile_record.name, claimed_handle,
		created_lix_id, 'repository'::text, 'repository'::text, true;
end;
$$;
