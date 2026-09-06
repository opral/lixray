-- Apply the review fixes to previews that already ran the neutral-account migration.

create or replace function public.current_account()
returns table(account_id uuid, kind text, profile_uri text, name text)
language sql stable security definer
set search_path to ''
as $$
	select account.id, account.kind,
		'https://lixray.com/profile/' || namespace.id::text,
		coalesce(nullif(btrim(profile.document #>> '{name,full}'), ''), namespace.name, 'Account')
	from public.accounts account
	left join public.namespaces namespace on namespace.id = account.primary_namespace_id
	left join public.namespace_profiles profile on profile.namespace_id = namespace.id
	where account.id = private.current_account_id();
$$;

create or replace function public.remove_namespace_member(p_namespace_id uuid, p_account_id uuid)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare current_account_id uuid := private.current_account_id(); owner_count integer;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	-- Serialize removals so two owners cannot both leave after counting each other.
	perform 1 from public.namespaces where id = p_namespace_id for update;
	if exists (
		select 1 from public.accounts account
		where account.primary_namespace_id = p_namespace_id
	) then
		raise exception 'Personal namespaces cannot be left or have members removed';
	end if;
	if p_account_id <> current_account_id
		and not private.is_namespace_owner(p_namespace_id, current_account_id) then
		raise exception 'Namespace owner access required';
	end if;
	if not private.is_namespace_member(p_namespace_id, current_account_id) then
		raise exception 'Namespace access denied';
	end if;
	select count(*) into owner_count from public.namespace_members
	where namespace_id = p_namespace_id and role = 'owner';
	if owner_count <= 1 and exists (
		select 1 from public.namespace_members
		where namespace_id = p_namespace_id and account_id = p_account_id and role = 'owner'
	) then raise exception 'An organization must keep at least one owner'; end if;
	delete from public.namespace_members where namespace_id = p_namespace_id and account_id = p_account_id;
	delete from public.lix_members repository_member
	using public.lixes repository
	where repository_member.lix_id = repository.id
		and repository.namespace_id = p_namespace_id
		and repository_member.account_id = p_account_id;
end;
$$;
