-- Remove the namespace kind enum.
--
-- 'personal' duplicated information the schema already carries: a namespace
-- is personal exactly when it is some user's primary namespace
-- (user_primary_namespaces), and nothing server-side ever branched on the
-- column. Storing it twice invited divergence (nothing constrained the enum
-- and the primary pointer to agree). list_accessible_lixes now derives a
-- namespace_is_personal boolean instead; a future personal→organization
-- conversion is "drop the primary pointer", one authoritative fact.

-- The return type changes, so the function cannot be replaced in place.
drop function public.list_accessible_lixes();

create function public.list_accessible_lixes()
returns table(
	namespace_id uuid,
	namespace_is_personal boolean,
	namespace_name text,
	namespace_handle text,
	namespace_created_at timestamptz,
	namespace_updated_at timestamptz,
	namespace_role public.namespace_role,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	lix_created_at timestamptz,
	lix_updated_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
	select namespace.id,
		exists (
			select 1 from public.user_primary_namespaces primary_namespace
			where primary_namespace.namespace_id = namespace.id
		),
		namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, namespace_member.role,
		lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at
	from public.namespaces namespace
	join public.handles handle
		on handle.namespace_id = namespace.id and handle.state = 'active'
	join public.namespace_members namespace_member
		on namespace_member.namespace_id = namespace.id and namespace_member.user_id = auth.uid()
	left join public.lixes lix
		on lix.namespace_id = namespace.id and lix.deleted_at is null
	where auth.uid() is not null
	union all
	select namespace.id,
		exists (
			select 1 from public.user_primary_namespaces primary_namespace
			where primary_namespace.namespace_id = namespace.id
		),
		namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, null::public.namespace_role,
		lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at
	from public.lix_members lix_member
	join public.lixes lix on lix.id = lix_member.lix_id and lix.deleted_at is null
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle
		on handle.namespace_id = namespace.id and handle.state = 'active'
	where lix_member.user_id = auth.uid()
		and not exists (
			select 1 from public.namespace_members namespace_member
			where namespace_member.namespace_id = namespace.id
				and namespace_member.user_id = auth.uid()
		)
	order by 5 asc, 10 asc;
$$;

revoke all on function public.list_accessible_lixes() from public;
grant all on function public.list_accessible_lixes() to authenticated;

create or replace function public.create_namespace(p_name text)
returns uuid
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	normalized_name text := btrim(coalesce(p_name, ''));
	new_namespace_id uuid;
	claimed_handle text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if char_length(normalized_name) not between 1 and 80 then
		raise exception 'Organization name must be between 1 and 80 characters';
	end if;
	claimed_handle := private.unique_handle(normalized_name, current_user_id);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));
	insert into public.namespaces (name)
	values (normalized_name)
	returning id into new_namespace_id;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (new_namespace_id, current_user_id, 'owner');
	insert into public.handles (handle, namespace_id)
	values (claimed_handle, new_namespace_id);
	return new_namespace_id;
end;
$$;

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
		join public.handles handle
			on handle.namespace_id = namespace.id and handle.state = 'active'
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

	insert into public.namespaces (name)
	values (profile_record.name)
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

alter table public.namespaces drop column kind;

drop type public.namespace_kind;
