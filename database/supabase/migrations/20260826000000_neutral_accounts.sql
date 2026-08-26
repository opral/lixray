-- Neutral application accounts.
--
-- auth.users rows are login methods. public.accounts are the stable actors used
-- by authorization, memberships, repository access and public account profiles.

create table public.accounts (
	id uuid primary key default gen_random_uuid(),
	kind text not null default 'human'
		constraint accounts_kind_valid check (char_length(btrim(kind)) between 1 and 40),
	status text not null default 'active'
		constraint accounts_status_valid check (status in ('active', 'suspended', 'deleted')),
	-- Null only between first authentication and personal namespace bootstrap.
	primary_namespace_id uuid unique
		references public.namespaces(id) on delete restrict,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table public.account_logins (
	auth_user_id uuid primary key references auth.users(id) on delete cascade,
	account_id uuid not null references public.accounts(id) on delete cascade,
	created_at timestamptz not null default now()
);

create index account_logins_account_id_idx on public.account_logins(account_id);

create trigger accounts_set_updated_at
before update on public.accounts
for each row execute function private.set_updated_at();

-- Preserve current actor UUIDs. This makes the cut lossless for every existing
-- account while allowing additional auth users to map to the same actor later.
insert into public.accounts (id, kind, status, primary_namespace_id, created_at)
select auth_user.id, 'human', 'active', primary_namespace.namespace_id,
	coalesce(auth_user.created_at, now())
from auth.users auth_user
left join public.user_primary_namespaces primary_namespace
	on primary_namespace.user_id = auth_user.id;

insert into public.account_logins (auth_user_id, account_id, created_at)
select auth_user.id, auth_user.id, coalesce(auth_user.created_at, now())
from auth.users auth_user;

create or replace function private.current_account_id()
returns uuid
language sql stable security definer
set search_path to ''
as $$
	select account.id
	from public.account_logins login
	join public.accounts account on account.id = login.account_id
	where login.auth_user_id = auth.uid()
		and account.status = 'active';
$$;

revoke all on function private.current_account_id() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_account_id() to authenticated;

-- Keep account creation synchronous with auth user creation. In particular,
-- an invite can be accepted on the OAuth callback before personal bootstrap.
create or replace function private.sync_auth_user_account()
returns trigger
language plpgsql security definer
set search_path to ''
as $$
begin
	insert into public.accounts (id, kind, status)
	values (new.id, 'human', 'active')
	on conflict (id) do nothing;

	insert into public.account_logins (auth_user_id, account_id)
	values (new.id, new.id)
	on conflict (auth_user_id) do nothing;

	return new;
end;
$$;

drop trigger auth_user_profile_sync on auth.users;
create trigger auth_user_account_sync
after insert on auth.users
for each row execute function private.sync_auth_user_account();
drop function private.sync_auth_user_profile();

-- Put canonical account identity into every newly minted access token. The
-- worker validates the JWT signature before trusting this claim.
create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql security definer
set search_path to ''
as $$
declare
	claims jsonb := coalesce(event -> 'claims', '{}'::jsonb) - 'account_id';
	oauth_client_id uuid := nullif(claims ->> 'client_id', '')::uuid;
	oauth_user_id uuid := nullif(coalesce(event ->> 'user_id', claims ->> 'sub'), '')::uuid;
	oauth_resource text := nullif(btrim(claims ->> 'resource'), '');
	canonical_account_id uuid;
begin
	select login.account_id into canonical_account_id
	from public.account_logins login
	join public.accounts account on account.id = login.account_id
	where login.auth_user_id = oauth_user_id and account.status = 'active';

	if canonical_account_id is not null then
		claims := jsonb_set(claims, '{account_id}', to_jsonb(canonical_account_id::text), true);
	end if;

	if oauth_client_id is not null then
		if oauth_resource is null then
			select oauth_authorization.resource into oauth_resource
			from auth.oauth_authorizations oauth_authorization
			where oauth_authorization.client_id = oauth_client_id
				and (oauth_user_id is null or oauth_authorization.user_id = oauth_user_id)
				and oauth_authorization.status = 'approved'
			order by oauth_authorization.approved_at desc nulls last,
				oauth_authorization.created_at desc
			limit 1;
		end if;
		oauth_resource := regexp_replace(
			regexp_replace(btrim(coalesce(oauth_resource, '')), '/+$', ''),
			'/mcp$', ''
		);
		if oauth_resource <> '' then
			claims := jsonb_set(claims, '{resource}', to_jsonb(oauth_resource), true);
		end if;
		claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	end if;

	return jsonb_build_object('claims', claims);
end;
$$;

-- Actor columns now reference accounts rather than auth credentials.
alter table public.namespace_members drop constraint namespace_members_user_id_fkey;
alter table public.namespace_members rename column user_id to account_id;
alter table public.namespace_members rename constraint namespace_members_pkey to namespace_members_pkey_old;
alter table public.namespace_members rename constraint namespace_members_pkey_old to namespace_members_pkey;
alter table public.namespace_members add constraint namespace_members_account_id_fkey
	foreign key (account_id) references public.accounts(id) on delete cascade;

alter table public.lix_members drop constraint lix_members_user_id_fkey;
alter table public.lix_members rename column user_id to account_id;
alter table public.lix_members add constraint lix_members_account_id_fkey
	foreign key (account_id) references public.accounts(id) on delete cascade;

alter table public.mcp_lix_connections drop constraint mcp_lix_connections_user_id_fkey;
alter table public.mcp_lix_connections rename column user_id to account_id;
alter table public.mcp_lix_connections add constraint mcp_lix_connections_account_id_fkey
	foreign key (account_id) references public.accounts(id) on delete cascade;

alter table public.lix_share_tokens drop constraint lix_share_tokens_shared_by_fkey;
alter table public.lix_share_tokens rename column shared_by to shared_by_account_id;
alter table public.lix_share_tokens add constraint lix_share_tokens_shared_by_account_id_fkey
	foreign key (shared_by_account_id) references public.accounts(id) on delete restrict;

alter table public.namespace_invite_links drop constraint namespace_invite_links_created_by_fkey;
alter table public.namespace_invite_links rename column created_by to created_by_account_id;
alter table public.namespace_invite_links add constraint namespace_invite_links_created_by_account_id_fkey
	foreign key (created_by_account_id) references public.accounts(id) on delete set null;

alter table public.lix_invite_links drop constraint lix_invite_links_created_by_fkey;
alter table public.lix_invite_links rename column created_by to created_by_account_id;
alter table public.lix_invite_links add constraint lix_invite_links_created_by_account_id_fkey
	foreign key (created_by_account_id) references public.accounts(id) on delete set null;

alter table public.lix_publications drop constraint lix_publications_published_by_fkey;
alter table public.lix_publications rename column published_by to published_by_account_id;
alter table public.lix_publications add constraint lix_publications_published_by_account_id_fkey
	foreign key (published_by_account_id) references public.accounts(id) on delete restrict;

create or replace function private.is_namespace_member(
	target_namespace_id uuid,
	target_user_id uuid default private.current_account_id()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select target_user_id is not null and (
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
	select target_user_id is not null and (
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
	select exists (
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
	select exists (
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

create or replace function private.can_access_lix_or_unseeded(
	target_lix_id uuid,
	target_namespace_id uuid,
	target_user_id uuid default private.current_account_id()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select private.can_access_lix(target_lix_id, target_user_id)
		or (
			not exists (select 1 from public.lix_members member where member.lix_id = target_lix_id)
			and private.is_namespace_member(target_namespace_id, target_user_id)
		);
$$;

create or replace function private.seed_lix_members_from_namespace()
returns trigger
language plpgsql security definer
set search_path to ''
as $$
begin
	insert into public.lix_members (lix_id, account_id, role)
	select new.id, member.account_id,
		case member.role when 'owner' then 'admin'::public.lix_role else 'member'::public.lix_role end
	from public.namespace_members member
	where member.namespace_id = new.namespace_id
	on conflict on constraint lix_members_pkey do nothing;
	insert into public.lix_members (lix_id, account_id, role)
	select new.id, account.id, 'admin'::public.lix_role
	from public.accounts account
	where account.primary_namespace_id = new.namespace_id
	on conflict on constraint lix_members_pkey do update set role = 'admin';
	return new;
end;
$$;

-- Replace policies whose stored expressions used auth.uid() directly.
drop policy if exists mcp_lix_connections_select_owner on public.mcp_lix_connections;
create policy mcp_lix_connections_select_owner on public.mcp_lix_connections
for select to authenticated using (
	account_id = private.current_account_id()
	and private.is_interactive_session()
	and private.can_access_lix(lix_id)
);

drop policy if exists lixes_select_accessible on public.lixes;
create policy lixes_select_accessible on public.lixes
for select to authenticated using (
	private.can_access_lix_or_unseeded(id, namespace_id)
);

-- The account API is the sole runtime bridge from a login to its actor/profile.
create or replace function public.current_account()
returns table(account_id uuid, kind text, profile_uri text, name text)
language sql stable security definer
set search_path to ''
as $$
	select account.id, account.kind,
		'https://lixray.com/profile/' || namespace.id::text,
		coalesce(profile.document #>> '{name,full}', namespace.name)
	from public.accounts account
	join public.namespaces namespace on namespace.id = account.primary_namespace_id
	left join public.namespace_profiles profile on profile.namespace_id = namespace.id
	where account.id = private.current_account_id();
$$;

revoke all on function public.current_account() from public, anon;
grant execute on function public.current_account() to authenticated;

alter table public.accounts enable row level security;
alter table public.account_logins enable row level security;
create policy accounts_select_self on public.accounts for select to authenticated
	using (id = private.current_account_id());
create policy account_logins_select_self on public.account_logins for select to authenticated
	using (account_id = private.current_account_id());
grant select on public.accounts, public.account_logins to authenticated;
grant all on public.accounts, public.account_logins to service_role;

create or replace function public.bootstrap_personal_namespace()
returns table(
	namespace_id uuid, namespace_name text, namespace_handle text,
	lix_id uuid, lix_name text, lix_slug text, created boolean
)
language plpgsql security definer
set search_path to ''
as $$
declare
	auth_user_id uuid := auth.uid();
	current_account_id uuid := private.current_account_id();
	auth_record auth.users%rowtype;
	existing_namespace_id uuid;
	created_namespace_id uuid;
	created_lix_id uuid;
	profile_name text;
	avatar_uri text;
	profile_document jsonb;
	claimed_handle text;
begin
	if auth_user_id is null or current_account_id is null then
		raise exception 'Authentication required';
	end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;

	perform pg_advisory_xact_lock(hashtextextended('personal-namespace:' || current_account_id::text, 0));
	select account.primary_namespace_id into existing_namespace_id
	from public.accounts account where account.id = current_account_id;

	if existing_namespace_id is not null then
		return query
		select namespace.id, namespace.name, handle.handle,
			repository.id, repository.name, repository.slug, false
		from public.namespaces namespace
		join public.handles handle
			on handle.namespace_id = namespace.id and handle.state = 'active'
		left join lateral (
			select candidate.id, candidate.name, candidate.slug
			from public.lixes candidate
			where candidate.namespace_id = namespace.id and candidate.deleted_at is null
			order by candidate.created_at asc limit 1
		) repository on true
		where namespace.id = existing_namespace_id;
		return;
	end if;

	select * into auth_record from auth.users where id = auth_user_id;
	profile_name := left(coalesce(
		nullif(btrim(auth_record.raw_user_meta_data ->> 'full_name'), ''),
		nullif(btrim(auth_record.raw_user_meta_data ->> 'name'), ''),
		nullif(split_part(coalesce(auth_record.email, ''), '@', 1), ''),
		'User'
	), 80);
	avatar_uri := coalesce(
		nullif(btrim(auth_record.raw_user_meta_data ->> 'avatar_url'), ''),
		nullif(btrim(auth_record.raw_user_meta_data ->> 'picture'), '')
	);
	profile_document := jsonb_build_object(
		'@type', 'Card', 'version', '2.0', 'kind', 'individual',
		'name', jsonb_build_object('full', profile_name)
	);
	if avatar_uri is not null then
		profile_document := profile_document || jsonb_build_object(
			'media', jsonb_build_object('avatar', jsonb_build_object(
				'@type', 'Media', 'kind', 'photo', 'uri', avatar_uri
			))
		);
	end if;

	claimed_handle := private.unique_handle(
		coalesce(nullif(split_part(coalesce(auth_record.email, ''), '@', 1), ''), profile_name),
		current_account_id
	);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));

	insert into public.namespaces (name) values (profile_name)
	returning id into created_namespace_id;
	insert into public.handles (handle, namespace_id) values (claimed_handle, created_namespace_id);
	insert into public.namespace_profiles (namespace_id, document)
	values (created_namespace_id, profile_document);
	update public.accounts set primary_namespace_id = created_namespace_id
	where id = current_account_id and primary_namespace_id is null;
	if not found then raise exception 'Account already has a personal namespace'; end if;
	insert into public.lixes (namespace_id, name, slug)
	values (created_namespace_id, 'repository', 'repository')
	returning id into created_lix_id;
	insert into public.lix_members (lix_id, account_id, role)
	values (created_lix_id, current_account_id, 'admin')
	on conflict on constraint lix_members_pkey do update set role = 'admin';

	return query select created_namespace_id, profile_name, claimed_handle,
		created_lix_id, 'repository'::text, 'repository'::text, true;
end;
$$;

create or replace function public.create_namespace(p_name text)
returns uuid
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id();
	normalized_name text := btrim(coalesce(p_name, ''));
	new_namespace_id uuid;
	claimed_handle text;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if char_length(normalized_name) not between 1 and 80 then
		raise exception 'Organization name must be between 1 and 80 characters';
	end if;
	claimed_handle := private.unique_handle(normalized_name, current_account_id);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));
	insert into public.namespaces (name) values (normalized_name) returning id into new_namespace_id;
	insert into public.namespace_members (namespace_id, account_id, role)
	values (new_namespace_id, current_account_id, 'owner');
	insert into public.handles (handle, namespace_id) values (claimed_handle, new_namespace_id);
	insert into public.namespace_profiles (namespace_id, document)
	values (new_namespace_id, jsonb_build_object(
		'@type', 'Card', 'version', '2.0', 'kind', 'org',
		'name', jsonb_build_object('full', normalized_name)
	));
	return new_namespace_id;
end;
$$;

drop function public.list_accessible_lixes();
create function public.list_accessible_lixes()
returns table(
	namespace_id uuid, namespace_is_personal boolean, namespace_name text,
	namespace_handle text, namespace_created_at timestamptz,
	namespace_updated_at timestamptz, namespace_role public.namespace_role,
	lix_id uuid, lix_name text, lix_slug text, lix_created_at timestamptz,
	lix_updated_at timestamptz, lix_role public.lix_role,
	lix_visibility public.lix_visibility
)
language sql stable security definer
set search_path to ''
as $$
	with current_actor as (
		select private.current_account_id() as id
	), scopes as (
		select account.primary_namespace_id as namespace_id,
			true as is_personal, 'owner'::public.namespace_role as role
		from public.accounts account, current_actor
		where account.id = current_actor.id and account.primary_namespace_id is not null
		union
		select member.namespace_id, false, member.role
		from public.namespace_members member, current_actor
		where member.account_id = current_actor.id
	)
	select namespace.id, scope.is_personal, namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, scope.role,
		repository.id, repository.name, repository.slug, repository.created_at,
		repository.updated_at, repository_member.role, repository.visibility
	from scopes scope
	join public.namespaces namespace on namespace.id = scope.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.lixes repository
		on repository.namespace_id = namespace.id and repository.deleted_at is null
	left join public.lix_members repository_member
		on repository_member.lix_id = repository.id
		and repository_member.account_id = (select id from current_actor)
	union all
	select namespace.id, false, namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, null::public.namespace_role,
		repository.id, repository.name, repository.slug, repository.created_at,
		repository.updated_at, repository_member.role, repository.visibility
	from public.lix_members repository_member
	join current_actor on current_actor.id = repository_member.account_id
	join public.lixes repository on repository.id = repository_member.lix_id and repository.deleted_at is null
	join public.namespaces namespace on namespace.id = repository.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id and handle.state = 'active'
	where not exists (select 1 from scopes where scopes.namespace_id = namespace.id)
	order by 5, 11 nulls first;
$$;

revoke all on function public.list_accessible_lixes() from public;
grant execute on function public.list_accessible_lixes() to authenticated;

create or replace function public.accept_namespace_invite(p_token text)
returns table(namespace_id uuid, namespace_name text, namespace_handle text)
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id();
	target_namespace_id uuid;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select link.namespace_id into target_namespace_id
	from public.namespace_invite_links link where link.token = coalesce(p_token, '');
	if target_namespace_id is null then raise exception 'Invalid or reset invite link'; end if;
	if exists (select 1 from public.accounts where primary_namespace_id = target_namespace_id) then
		raise exception 'Personal namespaces cannot have team members';
	end if;
	insert into public.namespace_members (namespace_id, account_id, role)
	values (target_namespace_id, current_account_id, 'member')
	on conflict on constraint namespace_members_pkey do nothing;
	insert into public.lix_members (lix_id, account_id, role)
	select repository.id, current_account_id, 'member'
	from public.lixes repository
	where repository.namespace_id = target_namespace_id and repository.deleted_at is null
	on conflict on constraint lix_members_pkey do nothing;
	return query
	select namespace.id, namespace.name, handle.handle
	from public.namespaces namespace
	join public.handles handle on handle.namespace_id = namespace.id and handle.state = 'active'
	where namespace.id = target_namespace_id;
end;
$$;

create or replace function public.accept_lix_share_token(p_token text)
returns uuid
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id();
	target_lix_id uuid;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select candidate.lix_id into target_lix_id
	from (
		select token.lix_id from public.lix_share_tokens token
		where token.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
			and token.revoked_at is null and token.can_edit
		union all
		select link.lix_id from public.lix_invite_links link
		where link.token = coalesce(p_token, '')
		limit 1
	) candidate;
	if target_lix_id is null then raise exception 'Invalid or revoked share link'; end if;
	insert into public.lix_members (lix_id, account_id, role)
	values (target_lix_id, current_account_id, 'member')
	on conflict on constraint lix_members_pkey do nothing;
	return target_lix_id;
end;
$$;

create or replace function public.record_mcp_lix_connection(p_lix_id uuid, p_tool_name text)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id();
	oauth_client_id text := nullif(auth.jwt() ->> 'client_id', '');
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_lixray_mcp_session() or oauth_client_id is null then
		raise exception 'LixRay MCP session required';
	end if;
	if not private.can_access_lix(p_lix_id, current_account_id) then raise exception 'Lix access denied'; end if;
	insert into public.mcp_lix_connections (
		account_id, lix_id, oauth_client_id, last_tool, connected_at, last_seen_at
	) values (
		current_account_id, p_lix_id, oauth_client_id, left(btrim(p_tool_name), 100), now(), now()
	)
	on conflict on constraint mcp_lix_connections_pkey do update
	set last_tool = excluded.last_tool, last_seen_at = now();
end;
$$;

create or replace function public.get_namespace_invite_link(p_namespace_id uuid)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id(); result text;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_namespace_owner(p_namespace_id, current_account_id) then raise exception 'Namespace owner access required'; end if;
	if exists (select 1 from public.accounts where primary_namespace_id = p_namespace_id) then
		raise exception 'Personal namespaces cannot have team members';
	end if;
	select link.token into result from public.namespace_invite_links link where link.namespace_id = p_namespace_id;
	if result is null then
		insert into public.namespace_invite_links (namespace_id, token, created_by_account_id)
		values (p_namespace_id, private.new_team_invite_token(), current_account_id)
		on conflict (namespace_id) do nothing;
		select link.token into result from public.namespace_invite_links link where link.namespace_id = p_namespace_id;
	end if;
	return result;
end;
$$;

create or replace function public.reset_namespace_invite_link(p_namespace_id uuid)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id(); result text;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_namespace_owner(p_namespace_id, current_account_id) then raise exception 'Namespace owner access required'; end if;
	if exists (select 1 from public.accounts where primary_namespace_id = p_namespace_id) then
		raise exception 'Personal namespaces cannot have team members';
	end if;
	insert into public.namespace_invite_links (namespace_id, token, created_by_account_id)
	values (p_namespace_id, private.new_team_invite_token(), current_account_id)
	on conflict (namespace_id) do update
	set token = excluded.token, created_by_account_id = excluded.created_by_account_id, created_at = now()
	returning token into result;
	return result;
end;
$$;

create or replace function public.get_lix_invite_link(p_lix_id uuid)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id(); result text;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_account_id) then raise exception 'Lix access denied'; end if;
	select link.token into result from public.lix_invite_links link where link.lix_id = p_lix_id;
	if result is null then
		insert into public.lix_invite_links (lix_id, token, created_by_account_id)
		values (p_lix_id, private.new_lix_invite_token(), current_account_id)
		on conflict (lix_id) do nothing;
		select link.token into result from public.lix_invite_links link where link.lix_id = p_lix_id;
	end if;
	return result;
end;
$$;

create or replace function public.reset_lix_invite_link(p_lix_id uuid)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
	current_account_id uuid := private.current_account_id(); result text;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_account_id) then raise exception 'Lix access denied'; end if;
	insert into public.lix_invite_links (lix_id, token, created_by_account_id)
	values (p_lix_id, private.new_lix_invite_token(), current_account_id)
	on conflict (lix_id) do update
	set token = excluded.token, created_by_account_id = excluded.created_by_account_id, created_at = now()
	returning token into result;
	return result;
end;
$$;

drop function public.remove_namespace_member(uuid, uuid);
create function public.remove_namespace_member(p_namespace_id uuid, p_account_id uuid)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare current_account_id uuid := private.current_account_id(); owner_count integer;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
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

drop function public.set_lix_member_role(uuid, uuid, public.lix_role);
create function public.set_lix_member_role(p_lix_id uuid, p_account_id uuid, p_role public.lix_role)
returns void
language plpgsql security definer
set search_path to ''
as $$
begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_lix_admin(p_lix_id) then raise exception 'Repository admin access required'; end if;
	if p_role <> 'admin' then raise exception 'Repository admins cannot be demoted'; end if;
	update public.lix_members set role = p_role where lix_id = p_lix_id and account_id = p_account_id;
	if not found then raise exception 'Repository member not found'; end if;
end;
$$;

drop function public.remove_lix_member(uuid, uuid);
create function public.remove_lix_member(p_lix_id uuid, p_account_id uuid)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare current_account_id uuid := private.current_account_id(); target_role public.lix_role;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if p_account_id <> current_account_id and not private.is_lix_admin(p_lix_id, current_account_id) then
		raise exception 'Repository admin access required';
	end if;
	select role into target_role from public.lix_members where lix_id = p_lix_id and account_id = p_account_id;
	if target_role = 'admin' then raise exception 'Repository admins cannot leave or be removed'; end if;
	delete from public.lix_members where lix_id = p_lix_id and account_id = p_account_id;
end;
$$;

create or replace function public.create_lix_share_token(p_lix_id uuid)
returns table(token text)
language plpgsql security definer
set search_path to ''
as $$
declare current_account_id uuid := private.current_account_id(); raw_token text;
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_account_id) then raise exception 'Lix access denied'; end if;
	raw_token := encode(extensions.gen_random_bytes(24), 'hex');
	insert into public.lix_share_tokens (lix_id, token_hash, shared_by_account_id)
	values (p_lix_id, encode(extensions.digest(raw_token, 'sha256'), 'hex'), current_account_id);
	return query select raw_token;
end;
$$;

create or replace function public.revoke_lix_share_token(p_token text)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare target_lix_id uuid;
begin
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select lix_id into target_lix_id from public.lix_share_tokens
	where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and revoked_at is null;
	if target_lix_id is null then return; end if;
	if not private.can_access_lix(target_lix_id) then raise exception 'Lix access denied'; end if;
	update public.lix_share_tokens set revoked_at = now()
	where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end;
$$;

drop function public.list_namespace_members(uuid);
create function public.list_namespace_members(p_namespace_id uuid)
returns table(
	account_id uuid, name text, email text, avatar_url text,
	role public.namespace_role, joined_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
	with all_members as (
		select member.account_id, member.role, member.created_at
		from public.namespace_members member
		where member.namespace_id = p_namespace_id
		union
		select account.id, 'owner'::public.namespace_role, account.created_at
		from public.accounts account
		where account.primary_namespace_id = p_namespace_id
	)
	select member.account_id,
		coalesce(profile.document #>> '{name,full}', namespace.name, 'Account'),
		case when member.account_id = private.current_account_id() then login.email end,
		profile.document #>> '{media,avatar,uri}',
		member.role, member.created_at
	from all_members member
	join public.accounts account on account.id = member.account_id
	left join public.namespaces namespace on namespace.id = account.primary_namespace_id
	left join public.namespace_profiles profile on profile.namespace_id = namespace.id
	left join lateral (
		select auth_user.email
		from public.account_logins account_login
		join auth.users auth_user on auth_user.id = account_login.auth_user_id
		where account_login.account_id = account.id
			and account_login.auth_user_id = auth.uid()
		limit 1
	) login on true
	where private.is_interactive_session()
		and private.is_namespace_member(p_namespace_id)
	order by member.created_at, name;
$$;

drop function public.list_lix_members(uuid);
create function public.list_lix_members(p_lix_id uuid)
returns table(
	account_id uuid, name text, email text, avatar_url text,
	role public.lix_role, joined_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
	select member.account_id,
		coalesce(profile.document #>> '{name,full}', namespace.name, 'Account'),
		case when member.account_id = private.current_account_id() then login.email end,
		profile.document #>> '{media,avatar,uri}',
		member.role, member.created_at
	from public.lix_members member
	join public.accounts account on account.id = member.account_id
	left join public.namespaces namespace on namespace.id = account.primary_namespace_id
	left join public.namespace_profiles profile on profile.namespace_id = namespace.id
	left join lateral (
		select auth_user.email
		from public.account_logins account_login
		join auth.users auth_user on auth_user.id = account_login.auth_user_id
		where account_login.account_id = account.id
			and account_login.auth_user_id = auth.uid()
		limit 1
	) login on true
	where member.lix_id = p_lix_id
		and private.is_interactive_session()
		and private.can_access_lix(p_lix_id)
	order by case member.role when 'admin' then 0 else 1 end, member.created_at, name;
$$;

drop function public.resolve_lix_share_token(text);
create function public.resolve_lix_share_token(p_token text)
returns table(
	namespace_id uuid, namespace_name text, namespace_handle text,
	lix_id uuid, lix_name text, lix_slug text,
	shared_by_name text, shared_by_avatar_url text, can_edit boolean,
	role public.lix_role, visibility public.lix_visibility, path_public boolean
)
language sql stable security definer
set search_path to ''
as $$
	with capability as (
		select token.lix_id, token.shared_by_account_id as account_id
		from public.lix_share_tokens token
		where token.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
			and token.revoked_at is null and token.can_edit
		union all
		select link.lix_id, link.created_by_account_id
		from public.lix_invite_links link where link.token = coalesce(p_token, '')
		limit 1
	)
	select namespace.id, namespace.name, handle.handle,
		repository.id, repository.name, repository.slug,
		coalesce(actor_profile.document #>> '{name,full}', actor_namespace.name),
		actor_profile.document #>> '{media,avatar,uri}',
		true, member.role, repository.visibility, repository.visibility = 'public'
	from capability
	join public.lixes repository on repository.id = capability.lix_id
	join public.namespaces namespace on namespace.id = repository.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.accounts actor on actor.id = capability.account_id
	left join public.namespaces actor_namespace on actor_namespace.id = actor.primary_namespace_id
	left join public.namespace_profiles actor_profile on actor_profile.namespace_id = actor_namespace.id
	left join public.lix_members member
		on member.lix_id = repository.id and member.account_id = private.current_account_id()
	where repository.deleted_at is null;
$$;

revoke all on function public.resolve_lix_share_token(text) from public;
grant execute on function public.resolve_lix_share_token(text) to anon, authenticated;

drop function public.resolve_public_lix(uuid, text);
create function public.resolve_public_lix(p_lix_id uuid, p_path text default null)
returns table(
	namespace_id uuid, namespace_name text, namespace_handle text,
	lix_id uuid, lix_name text, lix_slug text, can_edit boolean,
	role public.lix_role, visibility public.lix_visibility, path_public boolean
)
language sql stable security definer set search_path to ''
as $$
	select namespace.id, namespace.name, handle.handle,
		repository.id, repository.name, repository.slug,
		private.can_access_lix(repository.id), member.role, repository.visibility,
		private.is_lix_path_public(repository.id, p_path)
	from public.lixes repository
	join public.namespaces namespace on namespace.id = repository.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.lix_members member
		on member.lix_id = repository.id and member.account_id = private.current_account_id()
	where repository.id = p_lix_id and repository.deleted_at is null
		and (member.account_id is not null or repository.visibility = 'public'
			or private.is_lix_path_public(repository.id, p_path));
$$;

drop function public.resolve_public_lix_by_route(text, text, text);
create function public.resolve_public_lix_by_route(
	p_namespace_handle text, p_lix_slug text, p_path text default null
)
returns table(
	namespace_id uuid, namespace_name text, namespace_handle text,
	lix_id uuid, lix_name text, lix_slug text, can_edit boolean,
	role public.lix_role, visibility public.lix_visibility, path_public boolean
)
language sql stable security definer set search_path to ''
as $$
	select namespace.id, namespace.name, handle.handle,
		repository.id, repository.name, repository.slug,
		private.can_access_lix(repository.id), member.role, repository.visibility,
		private.is_lix_path_public(repository.id, p_path)
	from public.lixes repository
	join public.namespaces namespace on namespace.id = repository.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.lix_members member
		on member.lix_id = repository.id and member.account_id = private.current_account_id()
	where handle.handle = lower(btrim(coalesce(p_namespace_handle, '')))
		and repository.slug = lower(btrim(coalesce(p_lix_slug, '')))
		and repository.deleted_at is null
		and (member.account_id is not null or repository.visibility = 'public'
			or private.is_lix_path_public(repository.id, p_path));
$$;

revoke all on function public.resolve_public_lix(uuid, text) from public;
grant execute on function public.resolve_public_lix(uuid, text) to anon, authenticated;
revoke all on function public.resolve_public_lix_by_route(text, text, text) from public;
grant execute on function public.resolve_public_lix_by_route(text, text, text) to anon, authenticated;

create or replace function public.set_lix_visibility(p_lix_id uuid, p_visibility public.lix_visibility)
returns void language plpgsql security definer set search_path to ''
as $$ begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_lix_admin(p_lix_id) then raise exception 'Repository admin access required'; end if;
	update public.lixes set visibility = p_visibility where id = p_lix_id and deleted_at is null;
end; $$;

create or replace function public.publish_lix_resource(
	p_lix_id uuid, p_path text, p_kind public.lix_publication_kind
)
returns void language plpgsql security definer set search_path to ''
as $$
declare normalized_path text := private.normalize_lix_path(p_path); current_account_id uuid := private.current_account_id();
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_account_id) then raise exception 'Lix access denied'; end if;
	if normalized_path is null then raise exception 'Invalid publication path'; end if;
	insert into public.lix_publications (lix_id, path, kind, published_by_account_id)
	values (p_lix_id, normalized_path, p_kind, current_account_id)
	on conflict (lix_id, path, kind) do update
	set published_by_account_id = excluded.published_by_account_id, created_at = now();
end; $$;

create or replace function public.unpublish_lix_resource(
	p_lix_id uuid, p_path text, p_kind public.lix_publication_kind
)
returns void language plpgsql security definer set search_path to ''
as $$ begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id) then raise exception 'Lix access denied'; end if;
	delete from public.lix_publications
	where lix_id = p_lix_id and path = private.normalize_lix_path(p_path) and kind = p_kind;
end; $$;

drop function public.list_lix_publications(uuid);
create function public.list_lix_publications(p_lix_id uuid)
returns table(path text, kind public.lix_publication_kind, published_by_account_id uuid, created_at timestamptz)
language sql stable security definer set search_path to ''
as $$
	select publication.path, publication.kind, publication.published_by_account_id, publication.created_at
	from public.lix_publications publication
	where publication.lix_id = p_lix_id and private.can_access_lix(p_lix_id)
	order by publication.path, publication.kind;
$$;

create or replace function public.delete_lix(p_lix_id uuid)
returns void language plpgsql security definer set search_path to ''
as $$ begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_lix_admin(p_lix_id) then raise exception 'Repository admin access required'; end if;
	update public.lixes set deleted_at = now() where id = p_lix_id and deleted_at is null;
end; $$;

-- Personal namespace ownership is represented by accounts.primary_namespace_id,
-- not duplicated as an organization membership.
delete from public.namespace_members member
using public.accounts account
where account.primary_namespace_id = member.namespace_id
	and account.id = member.account_id;

drop trigger if exists profiles_set_updated_at on public.profiles;
drop policy if exists profiles_select_self on public.profiles;
drop table public.profiles;
drop table public.user_primary_namespaces;

revoke all on function public.bootstrap_personal_namespace() from public;
grant execute on function public.bootstrap_personal_namespace() to authenticated;
revoke all on function public.create_namespace(text) from public;
grant execute on function public.create_namespace(text) to authenticated;
revoke all on function public.list_namespace_members(uuid) from public;
grant execute on function public.list_namespace_members(uuid) to authenticated;
revoke all on function public.list_lix_members(uuid) from public;
grant execute on function public.list_lix_members(uuid) to authenticated;
revoke all on function public.remove_namespace_member(uuid, uuid) from public;
grant execute on function public.remove_namespace_member(uuid, uuid) to authenticated;
revoke all on function public.set_lix_member_role(uuid, uuid, public.lix_role) from public;
grant execute on function public.set_lix_member_role(uuid, uuid, public.lix_role) to authenticated;
revoke all on function public.remove_lix_member(uuid, uuid) from public;
grant execute on function public.remove_lix_member(uuid, uuid) to authenticated;
revoke all on function public.list_lix_publications(uuid) from public;
grant execute on function public.list_lix_publications(uuid) to authenticated;
