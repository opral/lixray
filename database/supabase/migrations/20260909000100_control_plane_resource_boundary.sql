-- OAuth identity alone is not authorization to use the LixRay control plane.
-- Keep the resource boundary at actor resolution as well as explicit membership
-- helpers: SECURITY DEFINER RPCs bypass RLS, but all user-derived identities use
-- current_account_id(). Public capabilities (publications, invite URLs and API
-- tokens) continue to authorize independently of a browser/OAuth identity.
create or replace function private.is_lixray_session()
returns boolean
language sql stable security definer
set search_path to ''
as $$
    select private.is_interactive_session() or private.is_lixray_mcp_session();
$$;

revoke all on function private.is_lixray_session() from public, anon;
grant execute on function private.is_lixray_session() to authenticated;


create or replace function private.current_account_id()
returns uuid
language sql stable security definer
set search_path to ''
as $$
	select account.id
	from public.account_logins login
	join public.accounts account on account.id = login.account_id
	where private.is_lixray_session()
		and login.auth_user_id = auth.uid()
		and account.status = 'active';
$$;

create or replace function private.is_namespace_member(
	target_namespace_id uuid,
	target_user_id uuid default private.current_account_id()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select private.is_lixray_session() and target_user_id is not null and (
		exists (
			select 1 from public.accounts account
			where account.id = target_user_id
				and account.status = 'active'
				and account.primary_namespace_id = target_namespace_id
		)
		or exists (
			select 1 from public.namespace_members member
			join public.accounts account on account.id = member.account_id
			where member.namespace_id = target_namespace_id
				and member.account_id = target_user_id
				and account.status = 'active'
		)
	);
$$;

create or replace function private.is_namespace_owner(
	target_namespace_id uuid,
	target_user_id uuid default private.current_account_id()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select private.is_lixray_session() and target_user_id is not null and (
		exists (
			select 1 from public.accounts account
			where account.id = target_user_id
				and account.status = 'active'
				and account.primary_namespace_id = target_namespace_id
		)
		or exists (
			select 1 from public.namespace_members member
			join public.accounts account on account.id = member.account_id
			where member.namespace_id = target_namespace_id
				and member.account_id = target_user_id
				and member.role = 'owner'
				and account.status = 'active'
		)
	);
$$;

create or replace function private.is_lix_admin(
	target_lix_id uuid,
	target_user_id uuid default private.current_account_id()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select private.is_lixray_session() and exists (
		select 1
		from public.lix_members member
		join public.lixes lix on lix.id = member.lix_id
		join public.accounts account on account.id = member.account_id
		where member.lix_id = target_lix_id
			and member.account_id = target_user_id
			and member.role = 'admin'
			and account.status = 'active'
			and lix.deleted_at is null
	);
$$;

create or replace function private.can_access_lix(
	target_lix_id uuid,
	target_user_id uuid default private.current_account_id()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select private.is_lixray_session() and exists (
		select 1
		from public.lix_members member
		join public.lixes lix on lix.id = member.lix_id
		join public.accounts account on account.id = member.account_id
		where member.lix_id = target_lix_id
			and member.account_id = target_user_id
			and account.status = 'active'
			and lix.deleted_at is null
	);
$$;

-- Publication names are literal paths, never SQL LIKE patterns.
create or replace function private.is_lix_path_public(
	target_lix_id uuid,
	target_path text
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select exists (
		select 1
		from public.lixes lix
		where lix.id = target_lix_id
			and lix.deleted_at is null
			and lix.visibility = 'public'
	)
	or exists (
		select 1
		from public.lix_publications publication
		where publication.lix_id = target_lix_id
			and private.normalize_lix_path(target_path) is not null
			and (
				(publication.kind = 'file'
					and publication.path = private.normalize_lix_path(target_path))
				or
				(publication.kind = 'directory' and (
					publication.path = '/'
					or publication.path = private.normalize_lix_path(target_path)
					or left(private.normalize_lix_path(target_path), length(publication.path) + 1)
						= publication.path || '/'
				))
			)
	);
$$;
