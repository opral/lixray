-- Repository authorization lives in the LixRay control plane.
--
-- Repository membership is authoritative for editing. Namespace membership
-- seeds memberships when a repository is created (and when a namespace invite
-- is accepted), but it is deliberately not consulted during authorization so
-- repository admins can remove an individual from one repository.

create type public.lix_role as enum ('admin', 'member');
create type public.lix_visibility as enum ('private', 'public');
create type public.lix_publication_kind as enum ('file', 'directory');

drop function public.list_lix_members(uuid);

alter table public.lix_members alter column role drop default;
alter table public.lix_members
	alter column role type public.lix_role
	using (
		case role::text
			when 'owner' then 'admin'::public.lix_role
			else 'member'::public.lix_role
		end
	);
alter table public.lix_members
	alter column role set default 'member'::public.lix_role;

alter table public.lixes
	add column visibility public.lix_visibility not null default 'private';

create table public.lix_publications (
	lix_id uuid not null references public.lixes(id) on delete cascade,
	path text not null,
	kind public.lix_publication_kind not null,
	published_by uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default now(),
	primary key (lix_id, path, kind),
	constraint lix_publications_absolute_path check (path ~ '^/(?:[^/]+(?:/[^/]+)*)?$'),
	constraint lix_publications_no_dot_segments check (
		path !~ '(^|/)\.\.?(/|$)'
	)
);

create index lix_publications_lix_path_idx
	on public.lix_publications (lix_id, path);

alter table public.lix_publications enable row level security;

-- The repository People surface needs one stable, resettable invite URL. This
-- is separate from one-shot lix_share_tokens, whose cleartext is intentionally
-- only returned once.
create table public.lix_invite_links (
	lix_id uuid primary key references public.lixes(id) on delete cascade,
	token text not null unique,
	created_by uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default now(),
	constraint lix_invite_links_token_valid check (
		token ~ '^ri_[A-Za-z0-9_-]{20}$'
	)
);

alter table public.lix_invite_links enable row level security;

-- Backfill all current namespace members. Namespace owners become repository
-- admins; other namespace members become normal repository members.
insert into public.lix_members (lix_id, user_id, role)
select lix.id, member.user_id,
	case member.role
		when 'owner' then 'admin'::public.lix_role
		else 'member'::public.lix_role
	end
from public.lixes lix
join public.namespace_members member on member.namespace_id = lix.namespace_id
where lix.deleted_at is null
on conflict (lix_id, user_id) do update
set role = case
	when excluded.role = 'admin' then 'admin'::public.lix_role
	else public.lix_members.role
end;

create or replace function private.is_lix_admin(
	target_lix_id uuid,
	target_user_id uuid default auth.uid()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select exists (
		select 1
		from public.lix_members member
		join public.lixes lix on lix.id = member.lix_id
		where member.lix_id = target_lix_id
			and member.user_id = target_user_id
			and member.role = 'admin'
			and lix.deleted_at is null
	);
$$;

create or replace function private.can_access_lix(
	target_lix_id uuid,
	target_user_id uuid default auth.uid()
)
returns boolean
language sql stable security definer
set search_path to ''
as $$
	select exists (
		select 1
		from public.lix_members member
		join public.lixes lix on lix.id = member.lix_id
		where member.lix_id = target_lix_id
			and member.user_id = target_user_id
			and lix.deleted_at is null
	);
$$;

create or replace function private.normalize_lix_path(source text)
returns text
language plpgsql immutable
set search_path to ''
as $$
declare
	normalized text := btrim(coalesce(source, ''));
begin
	if normalized = '' then return null; end if;
	if left(normalized, 1) <> '/' then normalized := '/' || normalized; end if;
	if normalized <> '/' then normalized := regexp_replace(normalized, '/+$', ''); end if;
	if normalized ~ '//' or normalized ~ '(^|/)\.\.?(/|$)' then return null; end if;
	return normalized;
end;
$$;

create or replace function private.new_lix_invite_token()
returns text
language plpgsql
set search_path to ''
as $$
declare
	token_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	token_bytes bytea := extensions.gen_random_bytes(20);
	raw_token text := 'ri_';
begin
	for i in 0..19 loop
		raw_token := raw_token || substr(
			token_alphabet,
			(get_byte(token_bytes, i) & 63) + 1,
			1
		);
	end loop;
	return raw_token;
end;
$$;

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
					or private.normalize_lix_path(target_path) like publication.path || '/%'
				))
			)
	);
$$;

create or replace function private.seed_lix_members_from_namespace()
returns trigger
language plpgsql security definer
set search_path to ''
as $$
begin
	insert into public.lix_members (lix_id, user_id, role)
	select new.id, member.user_id,
		case member.role
			when 'owner' then 'admin'::public.lix_role
			else 'member'::public.lix_role
		end
	from public.namespace_members member
	where member.namespace_id = new.namespace_id
	on conflict (lix_id, user_id) do nothing;
	return new;
end;
$$;

create trigger lixes_seed_members
after insert on public.lixes
for each row execute function private.seed_lix_members_from_namespace();

-- Namespace invitations keep their team-wide convenience by seeding current
-- repositories once. A later repository-level removal remains authoritative.
create or replace function public.accept_namespace_invite(p_token text)
returns table(namespace_id uuid, namespace_name text, namespace_handle text)
language plpgsql security definer
set search_path to ''
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
	insert into public.lix_members (lix_id, user_id, role)
	select lix.id, current_user_id, 'member'
	from public.lixes lix
	where lix.namespace_id = target_namespace_id and lix.deleted_at is null
	on conflict (lix_id, user_id) do nothing;
	return query
	select namespace.id, namespace.name, handle.handle
	from public.namespaces namespace
	join public.handles handle on handle.namespace_id = namespace.id
	where namespace.id = target_namespace_id;
end;
$$;

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
	lix_updated_at timestamptz,
	lix_role public.lix_role,
	lix_visibility public.lix_visibility
)
language sql stable security definer
set search_path to ''
as $$
	with accessible as (
		select namespace.id as namespace_id,
			exists (
				select 1 from public.user_primary_namespaces primary_namespace
				where primary_namespace.namespace_id = namespace.id
			) as namespace_is_personal,
			namespace.name as namespace_name,
			handle.handle as namespace_handle,
			namespace.created_at as namespace_created_at,
			namespace.updated_at as namespace_updated_at,
			namespace_member.role as namespace_role,
			repository.id as lix_id,
			repository.name as lix_name,
			repository.slug as lix_slug,
			repository.created_at as lix_created_at,
			repository.updated_at as lix_updated_at,
			repository.role as lix_role,
			repository.visibility as lix_visibility
		from public.namespaces namespace
		join public.handles handle
			on handle.namespace_id = namespace.id and handle.state = 'active'
		join public.namespace_members namespace_member
			on namespace_member.namespace_id = namespace.id
			and namespace_member.user_id = auth.uid()
		left join lateral (
			select lix.id, lix.name, lix.slug, lix.created_at,
				lix.updated_at, lix.visibility, lix_member.role
			from public.lix_members lix_member
			join public.lixes lix
				on lix.id = lix_member.lix_id and lix.deleted_at is null
			where lix_member.user_id = auth.uid()
				and lix.namespace_id = namespace.id
		) repository on true
		where auth.uid() is not null
		union all
		select namespace.id,
			exists (
				select 1 from public.user_primary_namespaces primary_namespace
				where primary_namespace.namespace_id = namespace.id
			),
			namespace.name, handle.handle,
			namespace.created_at, namespace.updated_at,
			null::public.namespace_role,
			lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at,
			lix_member.role, lix.visibility
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
	)
	select * from accessible
	order by namespace_created_at, lix_created_at nulls first;
$$;

revoke all on function public.list_accessible_lixes() from public;
grant all on function public.list_accessible_lixes() to authenticated;

drop function public.resolve_public_lix(uuid);
create function public.resolve_public_lix(p_lix_id uuid, p_path text default null)
returns table(
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	can_edit boolean,
	role public.lix_role,
	visibility public.lix_visibility,
	path_public boolean
)
language sql stable security definer
set search_path to ''
as $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug,
		private.can_access_lix(lix.id, auth.uid()),
		member.role, lix.visibility,
		private.is_lix_path_public(lix.id, p_path)
	from public.lixes lix
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle
		on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.lix_members member
		on member.lix_id = lix.id and member.user_id = auth.uid()
	where lix.id = p_lix_id
		and lix.deleted_at is null
		and (
			member.user_id is not null
			or lix.visibility = 'public'
			or private.is_lix_path_public(lix.id, p_path)
		);
$$;

drop function public.resolve_public_lix_by_route(text, text);
create function public.resolve_public_lix_by_route(
	p_namespace_handle text,
	p_lix_slug text,
	p_path text default null
)
returns table(
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	can_edit boolean,
	role public.lix_role,
	visibility public.lix_visibility,
	path_public boolean
)
language sql stable security definer
set search_path to ''
as $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug,
		private.can_access_lix(lix.id, auth.uid()),
		member.role, lix.visibility,
		private.is_lix_path_public(lix.id, p_path)
	from public.lixes lix
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle
		on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.lix_members member
		on member.lix_id = lix.id and member.user_id = auth.uid()
	where handle.handle = lower(btrim(coalesce(p_namespace_handle, '')))
		and lix.slug = lower(btrim(coalesce(p_lix_slug, '')))
		and lix.deleted_at is null
		and (
			member.user_id is not null
			or lix.visibility = 'public'
			or private.is_lix_path_public(lix.id, p_path)
		);
$$;

revoke all on function public.resolve_public_lix(uuid, text) from public;
grant all on function public.resolve_public_lix(uuid, text) to anon, authenticated;
revoke all on function public.resolve_public_lix_by_route(text, text, text) from public;
grant all on function public.resolve_public_lix_by_route(text, text, text) to anon, authenticated;

drop function public.resolve_lix_share_token(text);
create function public.resolve_lix_share_token(p_token text)
returns table(
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	shared_by_name text,
	shared_by_avatar_url text,
	can_edit boolean,
	role public.lix_role,
	visibility public.lix_visibility,
	path_public boolean
)
language sql stable security definer
set search_path to ''
as $$
	with capability as (
		select token.lix_id, token.shared_by
		from public.lix_share_tokens token
		where token.token_hash = encode(
			extensions.digest(coalesce(p_token, ''), 'sha256'),
			'hex'
		)
			and token.revoked_at is null
			and token.can_edit
		union all
		select link.lix_id, link.created_by
		from public.lix_invite_links link
		where link.token = coalesce(p_token, '')
		limit 1
	)
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, profile.name, profile.avatar_url,
		true, member.role, lix.visibility,
		(lix.visibility = 'public')
	from capability
	join public.lixes lix on lix.id = capability.lix_id
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle
		on handle.namespace_id = namespace.id and handle.state = 'active'
	left join public.profiles profile on profile.id = capability.shared_by
	left join public.lix_members member
		on member.lix_id = lix.id and member.user_id = auth.uid()
	where lix.deleted_at is null;
$$;

revoke all on function public.resolve_lix_share_token(text) from public;
grant all on function public.resolve_lix_share_token(text) to anon, authenticated;

create or replace function public.list_lix_members(p_lix_id uuid)
returns table(
	user_id uuid,
	name text,
	email text,
	avatar_url text,
	role public.lix_role,
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
	order by case member.role when 'admin' then 0 else 1 end,
		member.created_at, profile.name;
$$;

create or replace function public.get_lix_invite_link(p_lix_id uuid)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	existing_token text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_user_id) then
		raise exception 'Repository member access required';
	end if;
	select link.token into existing_token
	from public.lix_invite_links link
	where link.lix_id = p_lix_id;
	if existing_token is not null then return existing_token; end if;
	insert into public.lix_invite_links (lix_id, token, created_by)
	values (p_lix_id, private.new_lix_invite_token(), current_user_id)
	on conflict (lix_id) do nothing;
	select link.token into existing_token
	from public.lix_invite_links link
	where link.lix_id = p_lix_id;
	return existing_token;
end;
$$;

create or replace function public.reset_lix_invite_link(p_lix_id uuid)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	rotated_token text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_user_id) then
		raise exception 'Repository member access required';
	end if;
	insert into public.lix_invite_links (lix_id, token, created_by)
	values (p_lix_id, private.new_lix_invite_token(), current_user_id)
	on conflict (lix_id) do update
	set token = excluded.token,
		created_by = excluded.created_by,
		created_at = now()
	returning token into rotated_token;
	return rotated_token;
end;
$$;

create or replace function public.accept_lix_share_token(p_token text)
returns uuid
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	target_lix_id uuid;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select token.lix_id into target_lix_id
	from public.lix_share_tokens token
	join public.lixes lix on lix.id = token.lix_id
	where token.token_hash = encode(
		extensions.digest(coalesce(p_token, ''), 'sha256'),
		'hex'
	)
		and token.revoked_at is null
		and token.can_edit
		and lix.deleted_at is null;
	if target_lix_id is null then
		select link.lix_id into target_lix_id
		from public.lix_invite_links link
		join public.lixes lix on lix.id = link.lix_id
		where link.token = coalesce(p_token, '')
			and lix.deleted_at is null;
	end if;
	if target_lix_id is null then raise exception 'Invalid or revoked share link'; end if;
	insert into public.lix_members (lix_id, user_id, role)
	values (target_lix_id, current_user_id, 'member')
	on conflict (lix_id, user_id) do nothing;
	return target_lix_id;
end;
$$;

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
	current_role public.lix_role;
	admin_count bigint;
begin
	if auth.uid() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_lix_admin(p_lix_id, auth.uid()) then
		raise exception 'Repository admin access required';
	end if;
	perform pg_advisory_xact_lock(hashtextextended('lix-admins:' || p_lix_id::text, 0));
	select role into current_role from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
	if current_role is null then raise exception 'Repository member not found'; end if;
	if current_role = 'admin' and p_role = 'member' then
		select count(*) into admin_count from public.lix_members
		where lix_id = p_lix_id and role = 'admin';
		if admin_count <= 1 then raise exception 'Repository must keep at least one admin'; end if;
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
	admin_count bigint;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if p_user_id <> current_user_id
		and not private.is_lix_admin(p_lix_id, current_user_id) then
		raise exception 'Repository admin access required';
	end if;
	perform pg_advisory_xact_lock(hashtextextended('lix-admins:' || p_lix_id::text, 0));
	select role into target_role from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
	if target_role = 'admin' then
		select count(*) into admin_count from public.lix_members
		where lix_id = p_lix_id and role = 'admin';
		if admin_count <= 1 then raise exception 'Repository must keep at least one admin'; end if;
	end if;
	delete from public.lix_members
	where lix_id = p_lix_id and user_id = p_user_id;
end;
$$;

create or replace function public.set_lix_visibility(
	p_lix_id uuid,
	p_visibility public.lix_visibility
)
returns void
language plpgsql security definer
set search_path to ''
as $$
begin
	if auth.uid() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_lix_admin(p_lix_id, auth.uid()) then
		raise exception 'Repository admin access required';
	end if;
	update public.lixes set visibility = p_visibility where id = p_lix_id;
end;
$$;

create or replace function public.publish_lix_resource(
	p_lix_id uuid,
	p_path text,
	p_kind public.lix_publication_kind
)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare
	normalized_path text := private.normalize_lix_path(p_path);
begin
	if auth.uid() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, auth.uid()) then
		raise exception 'Repository member access required';
	end if;
	if normalized_path is null then raise exception 'Invalid repository path'; end if;
	insert into public.lix_publications (lix_id, path, kind, published_by)
	values (p_lix_id, normalized_path, p_kind, auth.uid())
	on conflict (lix_id, path, kind) do nothing;
end;
$$;

create or replace function public.unpublish_lix_resource(
	p_lix_id uuid,
	p_path text,
	p_kind public.lix_publication_kind
)
returns void
language plpgsql security definer
set search_path to ''
as $$
declare
	normalized_path text := private.normalize_lix_path(p_path);
begin
	if auth.uid() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, auth.uid()) then
		raise exception 'Repository member access required';
	end if;
	if normalized_path is null then raise exception 'Invalid repository path'; end if;
	delete from public.lix_publications
	where lix_id = p_lix_id and path = normalized_path and kind = p_kind;
end;
$$;

create or replace function public.list_lix_publications(p_lix_id uuid)
returns table(
	path text,
	kind public.lix_publication_kind,
	published_by uuid,
	created_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
	select publication.path, publication.kind,
		publication.published_by, publication.created_at
	from public.lix_publications publication
	where publication.lix_id = p_lix_id
		and private.can_access_lix(p_lix_id, auth.uid())
	order by publication.path, publication.kind;
$$;

create or replace function public.delete_lix(p_lix_id uuid)
returns void
language plpgsql security definer
set search_path to ''
as $$
begin
	if not private.is_lix_admin(p_lix_id, auth.uid()) then
		raise exception 'Repository admin access required';
	end if;
	update public.lixes set deleted_at = now()
	where id = p_lix_id and deleted_at is null;
end;
$$;

drop policy lixes_update_namespace_owner on public.lixes;
create policy lixes_update_repository_admin
	on public.lixes for update to authenticated
	using (private.is_interactive_session() and private.is_lix_admin(id))
	with check (private.is_interactive_session() and private.is_lix_admin(id));

revoke all on function public.set_lix_member_role(uuid, uuid, public.lix_role) from public;
grant all on function public.set_lix_member_role(uuid, uuid, public.lix_role) to authenticated;
revoke all on function public.list_lix_members(uuid) from public;
grant all on function public.list_lix_members(uuid) to authenticated;
revoke all on function public.remove_lix_member(uuid, uuid) from public;
grant all on function public.remove_lix_member(uuid, uuid) to authenticated;
revoke all on function public.get_lix_invite_link(uuid) from public;
grant all on function public.get_lix_invite_link(uuid) to authenticated;
revoke all on function public.reset_lix_invite_link(uuid) from public;
grant all on function public.reset_lix_invite_link(uuid) to authenticated;
revoke all on function private.new_lix_invite_token() from public;
revoke all on function public.set_lix_visibility(uuid, public.lix_visibility) from public;
grant all on function public.set_lix_visibility(uuid, public.lix_visibility) to authenticated;
revoke all on function public.publish_lix_resource(uuid, text, public.lix_publication_kind) from public;
grant all on function public.publish_lix_resource(uuid, text, public.lix_publication_kind) to authenticated;
revoke all on function public.unpublish_lix_resource(uuid, text, public.lix_publication_kind) from public;
grant all on function public.unpublish_lix_resource(uuid, text, public.lix_publication_kind) to authenticated;
revoke all on function public.list_lix_publications(uuid) from public;
grant all on function public.list_lix_publications(uuid) to authenticated;
