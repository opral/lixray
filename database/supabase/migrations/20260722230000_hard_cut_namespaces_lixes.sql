-- LixRay is pre-compatibility: replace the application schema in one migration
-- so already-provisioned Supabase projects and fresh local databases converge
-- on the same namespace + Lix model. Auth/storage schemas are intentionally
-- untouched.

drop schema if exists public cascade;
drop schema if exists private cascade;

create schema public;
create schema private;

grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
grant usage on schema private to authenticated, supabase_auth_admin;
revoke all on schema private from public, anon;

create type public.namespace_kind as enum ('personal', 'organization');
create type public.namespace_role as enum ('owner', 'member');

create table public.profiles (
	id uuid primary key references auth.users(id) on delete cascade,
	email text not null,
	name text not null,
	avatar_url text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint profiles_email_normalized check (email = lower(btrim(email))),
	constraint profiles_name_valid check (char_length(btrim(name)) between 1 and 80)
);

create table public.namespaces (
	id uuid primary key default gen_random_uuid(),
	kind public.namespace_kind not null,
	name text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint namespaces_name_valid check (char_length(btrim(name)) between 1 and 80)
);

create table public.namespace_members (
	namespace_id uuid not null references public.namespaces(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	role public.namespace_role not null default 'member',
	created_at timestamptz not null default now(),
	primary key (namespace_id, user_id)
);

create table public.user_primary_namespaces (
	user_id uuid primary key references auth.users(id) on delete cascade,
	namespace_id uuid not null unique references public.namespaces(id) on delete cascade,
	created_at timestamptz not null default now()
);

create table public.handles (
	handle text primary key,
	squat_key text generated always as (replace(handle, '-', '')) stored,
	namespace_id uuid not null unique references public.namespaces(id) on delete cascade,
	created_at timestamptz not null default now(),
	constraint handles_valid check (
		handle ~ '^[a-z0-9](?:-?[a-z0-9]){0,38}$'
		and char_length(handle) <= 39
	)
);

create unique index handles_squat_key_unique on public.handles(squat_key);

create table public.lixes (
	id uuid primary key default gen_random_uuid(),
	namespace_id uuid not null references public.namespaces(id) on delete cascade,
	name text not null,
	slug text not null,
	slug_squat_key text generated always as (replace(slug, '-', '')) stored,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	deleted_at timestamptz,
	constraint lixes_name_valid check (char_length(btrim(name)) between 1 and 80),
	constraint lixes_slug_valid check (
		slug ~ '^[a-z0-9](?:-?[a-z0-9]){0,99}$'
		and char_length(slug) <= 100
	)
);

create unique index lixes_namespace_slug_unique
	on public.lixes(namespace_id, slug);
create unique index lixes_namespace_slug_squat_unique
	on public.lixes(namespace_id, slug_squat_key);
create index lixes_namespace_id_idx on public.lixes(namespace_id);

create table public.lix_members (
	lix_id uuid not null references public.lixes(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	role public.namespace_role not null default 'member',
	created_at timestamptz not null default now(),
	primary key (lix_id, user_id)
);

create table public.lix_share_tokens (
	id uuid primary key default gen_random_uuid(),
	lix_id uuid not null references public.lixes(id) on delete cascade,
	token_hash text not null unique,
	shared_by uuid not null references auth.users(id) on delete restrict,
	can_edit boolean not null default true,
	created_at timestamptz not null default now(),
	revoked_at timestamptz,
	constraint lix_share_tokens_hash_valid check (token_hash ~ '^[0-9a-f]{64}$')
);

create table public.user_lix_preferences (
	user_id uuid not null references auth.users(id) on delete cascade,
	lix_id uuid not null references public.lixes(id) on delete cascade,
	atelier_layout jsonb not null,
	updated_at timestamptz not null default now(),
	primary key (user_id, lix_id)
);

create table public.user_lix_review_resolutions (
	user_id uuid not null references auth.users(id) on delete cascade,
	lix_id uuid not null references public.lixes(id) on delete cascade,
	branch_id text not null,
	review_id text not null,
	file_id text not null,
	outcome text not null check (outcome in ('accepted', 'rejected', 'resolved')),
	resolved_at timestamptz not null default now(),
	primary key (user_id, lix_id, branch_id, review_id, file_id)
);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.updated_at := now();
	return new;
end;
$$;

create or replace function private.url_segment(source text, max_length integer)
returns text
language sql
immutable
set search_path = ''
as $$
	select left(
		trim(both '-' from regexp_replace(
			regexp_replace(lower(btrim(coalesce(source, ''))), '[^a-z0-9]+', '-', 'g'),
			'-+', '-', 'g'
		)),
		max_length
	);
$$;

create or replace function private.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	profile_name text;
begin
	profile_name := coalesce(
		nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
		nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
		nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
		'User'
	);

	insert into public.profiles (id, email, name, avatar_url)
	values (
		new.id,
		lower(btrim(coalesce(new.email, ''))),
		left(profile_name, 80),
		coalesce(
			nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
			nullif(new.raw_user_meta_data ->> 'picture', '')
		)
	)
	on conflict (id) do update
	set email = excluded.email,
		name = excluded.name,
		avatar_url = excluded.avatar_url;

	return new;
end;
$$;

drop trigger if exists auth_user_profile_sync on auth.users;
create trigger auth_user_profile_sync
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function private.sync_auth_user_profile();

-- A production hard cut keeps auth identities while replacing the application
-- schema, so existing users need the same profile materialization as new users.
insert into public.profiles (id, email, name, avatar_url)
select
	user_record.id,
	lower(btrim(coalesce(user_record.email, ''))),
	left(coalesce(
		nullif(btrim(user_record.raw_user_meta_data ->> 'full_name'), ''),
		nullif(btrim(user_record.raw_user_meta_data ->> 'name'), ''),
		nullif(split_part(coalesce(user_record.email, ''), '@', 1), ''),
		'User'
	), 80),
	coalesce(
		nullif(user_record.raw_user_meta_data ->> 'avatar_url', ''),
		nullif(user_record.raw_user_meta_data ->> 'picture', '')
	)
from auth.users user_record;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger namespaces_set_updated_at
before update on public.namespaces
for each row execute function private.set_updated_at();

create trigger lixes_set_updated_at
before update on public.lixes
for each row execute function private.set_updated_at();

create trigger user_lix_preferences_set_updated_at
before update on public.user_lix_preferences
for each row execute function private.set_updated_at();

create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
	if coalesce(claims ->> 'client_id', '') <> '' then
		claims := jsonb_set(claims, '{resource}', to_jsonb('https://lixray.com'::text), true);
		claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	end if;
	return jsonb_build_object('claims', claims);
end;
$$;

revoke all on function private.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;

create or replace function private.is_lixray_mcp_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce((select auth.jwt() ->> 'lixray_mcp')::boolean, false)
		and (select auth.jwt() ->> 'resource') = 'https://lixray.com'
		and nullif((select auth.jwt() ->> 'client_id'), '') is not null;
$$;

create or replace function private.is_interactive_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select nullif((select auth.jwt() ->> 'client_id'), '') is null;
$$;

create or replace function private.is_namespace_member(
	target_namespace_id uuid,
	target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.namespace_members
		where namespace_id = target_namespace_id and user_id = target_user_id
	);
$$;

create or replace function private.is_namespace_owner(
	target_namespace_id uuid,
	target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.namespace_members
		where namespace_id = target_namespace_id
			and user_id = target_user_id
			and role = 'owner'
	);
$$;

create or replace function private.can_access_lix(
	target_lix_id uuid,
	target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.lixes lix
		where lix.id = target_lix_id
			and lix.deleted_at is null
			and (
				private.is_namespace_member(lix.namespace_id, target_user_id)
				or exists (
					select 1 from public.lix_members
					where lix_id = target_lix_id and user_id = target_user_id
				)
			)
	);
$$;

create or replace function private.unique_handle(base text, user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
	candidate text := coalesce(nullif(private.url_segment(base, 39), ''), 'user');
begin
	if not exists (
		select 1 from public.handles
		where squat_key = replace(candidate, '-', '')
	) then
		return candidate;
	end if;
	return left(candidate, 26) || '-' || left(replace(user_id::text, '-', ''), 12);
end;
$$;

create or replace function public.bootstrap_personal_namespace()
returns table (
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
	values (created_namespace_id, 'Workspace', 'workspace')
	returning id into created_lix_id;

	return query select created_namespace_id, profile_record.name, claimed_handle,
		created_lix_id, 'Workspace'::text, 'workspace'::text, true;
end;
$$;

create or replace function public.create_namespace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
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
	insert into public.namespaces (kind, name)
	values ('organization', normalized_name)
	returning id into new_namespace_id;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (new_namespace_id, current_user_id, 'owner');
	insert into public.handles (handle, namespace_id)
	values (claimed_handle, new_namespace_id);
	return new_namespace_id;
end;
$$;

create or replace function public.rename_namespace(p_namespace_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare normalized_name text := btrim(coalesce(p_name, ''));
begin
	if not private.is_namespace_owner(p_namespace_id) then raise exception 'Namespace owner access required'; end if;
	if char_length(normalized_name) not between 1 and 80 then raise exception 'Namespace name must be between 1 and 80 characters'; end if;
	update public.namespaces set name = normalized_name where id = p_namespace_id;
end;
$$;

create or replace function public.list_accessible_lixes()
returns table (
	namespace_id uuid,
	namespace_kind public.namespace_kind,
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
language sql
stable
security definer
set search_path = ''
as $$
	select namespace.id, namespace.kind, namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, namespace_member.role,
		lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at
	from public.namespaces namespace
	join public.handles handle on handle.namespace_id = namespace.id
	join public.namespace_members namespace_member
		on namespace_member.namespace_id = namespace.id and namespace_member.user_id = auth.uid()
	left join public.lixes lix
		on lix.namespace_id = namespace.id and lix.deleted_at is null
	where auth.uid() is not null
	union all
	select namespace.id, namespace.kind, namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, null::public.namespace_role,
		lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at
	from public.lix_members lix_member
	join public.lixes lix on lix.id = lix_member.lix_id and lix.deleted_at is null
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	where lix_member.user_id = auth.uid()
		and not exists (
			select 1 from public.namespace_members namespace_member
			where namespace_member.namespace_id = namespace.id
				and namespace_member.user_id = auth.uid()
		)
	order by 5 asc, 10 asc;
$$;

create or replace function public.resolve_public_lix(p_lix_id uuid)
returns table (
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	can_edit boolean
)
language sql
stable
security definer
set search_path = ''
as $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, private.can_access_lix(lix.id, auth.uid())
	from public.lixes lix
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	where lix.id = p_lix_id and lix.deleted_at is null;
$$;

create or replace function public.resolve_public_lix_by_route(p_namespace_handle text, p_lix_slug text)
returns table (
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	can_edit boolean
)
language sql
stable
security definer
set search_path = ''
as $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, private.can_access_lix(lix.id, auth.uid())
	from public.lixes lix
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	where handle.handle = lower(btrim(coalesce(p_namespace_handle, '')))
		and lix.slug = lower(btrim(coalesce(p_lix_slug, '')))
		and lix.deleted_at is null;
$$;

create or replace function public.delete_lix(p_lix_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not private.is_namespace_owner((select namespace_id from public.lixes where id = p_lix_id)) then
		raise exception 'Namespace owner access required';
	end if;
	update public.lixes set deleted_at = now() where id = p_lix_id and deleted_at is null;
end;
$$;

create or replace function public.resolve_lix_share_token(p_token text)
returns table (
	namespace_id uuid,
	namespace_name text,
	namespace_handle text,
	lix_id uuid,
	lix_name text,
	lix_slug text,
	shared_by_name text,
	shared_by_avatar_url text,
	can_edit boolean
)
language sql
stable
security definer
set search_path = ''
as $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, profile.name, profile.avatar_url, token.can_edit
	from public.lix_share_tokens token
	join public.lixes lix on lix.id = token.lix_id
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	left join public.profiles profile on profile.id = token.shared_by
	where token.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
		and token.revoked_at is null and token.can_edit and lix.deleted_at is null;
$$;

create or replace function public.create_lix_share_token(p_lix_id uuid)
returns table (token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_user_id uuid := auth.uid();
	token_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	token_bytes bytea := extensions.gen_random_bytes(21);
	raw_token text := '';
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_user_id) then raise exception 'Lix edit access required'; end if;
	for i in 0..20 loop
		raw_token := raw_token || substr(token_alphabet, (get_byte(token_bytes, i) & 63) + 1, 1);
	end loop;
	insert into public.lix_share_tokens (lix_id, token_hash, shared_by)
	values (p_lix_id, encode(extensions.digest(raw_token, 'sha256'), 'hex'), current_user_id);
	return query select raw_token;
end;
$$;

create or replace function public.accept_lix_share_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
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
	where token.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
		and token.revoked_at is null and token.can_edit and lix.deleted_at is null;
	if target_lix_id is null then raise exception 'Invalid or revoked share link'; end if;
	insert into public.lix_members (lix_id, user_id, role)
	values (target_lix_id, current_user_id, 'member')
	on conflict (lix_id, user_id) do nothing;
	return target_lix_id;
end;
$$;

create or replace function public.revoke_lix_share_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target_lix_id uuid;
begin
	select lix_id into target_lix_id from public.lix_share_tokens
	where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
	if target_lix_id is null or not private.can_access_lix(target_lix_id) then
		raise exception 'Lix edit access required';
	end if;
	update public.lix_share_tokens set revoked_at = now()
	where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end;
$$;

alter table public.profiles enable row level security;
alter table public.namespaces enable row level security;
alter table public.namespace_members enable row level security;
alter table public.user_primary_namespaces enable row level security;
alter table public.handles enable row level security;
alter table public.lixes enable row level security;
alter table public.lix_members enable row level security;
alter table public.lix_share_tokens enable row level security;
alter table public.user_lix_preferences enable row level security;
alter table public.user_lix_review_resolutions enable row level security;

create policy profiles_select_self on public.profiles
	for select to authenticated using (id = (select auth.uid()) and private.is_interactive_session());
create policy namespaces_select_member on public.namespaces
	for select to authenticated using (private.is_namespace_member(id));
create policy namespace_members_select_member on public.namespace_members
	for select to authenticated using (private.is_namespace_member(namespace_id));
create policy handles_select_member on public.handles
	for select to authenticated using (private.is_namespace_member(namespace_id));
create policy lixes_select_accessible on public.lixes
	for select to authenticated using (private.can_access_lix(id));
create policy lixes_insert_namespace_member on public.lixes
	for insert to authenticated with check (
		private.is_interactive_session() and private.is_namespace_member(namespace_id)
	);
create policy lixes_update_namespace_owner on public.lixes
	for update to authenticated using (
		private.is_interactive_session() and private.is_namespace_owner(namespace_id)
	) with check (
		private.is_interactive_session() and private.is_namespace_owner(namespace_id)
	);
create policy user_lix_preferences_owner on public.user_lix_preferences
	for all to authenticated using (
		user_id = (select auth.uid()) and private.is_interactive_session() and private.can_access_lix(lix_id)
	) with check (
		user_id = (select auth.uid()) and private.is_interactive_session() and private.can_access_lix(lix_id)
	);
create policy user_lix_review_resolutions_owner on public.user_lix_review_resolutions
	for all to authenticated using (
		user_id = (select auth.uid()) and private.is_interactive_session() and private.can_access_lix(lix_id)
	) with check (
		user_id = (select auth.uid()) and private.is_interactive_session() and private.can_access_lix(lix_id)
	);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.namespaces, public.namespace_members, public.handles, public.lixes
	to authenticated;
grant insert, update (name) on public.lixes to authenticated;
grant select, insert, update, delete on public.user_lix_preferences to authenticated;
grant select, insert, update, delete on public.user_lix_review_resolutions to authenticated;

revoke all on all functions in schema public from public, anon;
grant execute on function public.bootstrap_personal_namespace() to authenticated;
grant execute on function public.create_namespace(text) to authenticated;
grant execute on function public.rename_namespace(uuid, text) to authenticated;
grant execute on function public.list_accessible_lixes() to authenticated;
grant execute on function public.resolve_public_lix(uuid) to anon, authenticated;
grant execute on function public.resolve_public_lix_by_route(text, text) to anon, authenticated;
grant execute on function public.delete_lix(uuid) to authenticated;
grant execute on function public.resolve_lix_share_token(text) to anon, authenticated;
grant execute on function public.create_lix_share_token(uuid) to authenticated;
grant execute on function public.accept_lix_share_token(text) to authenticated;
grant execute on function public.revoke_lix_share_token(text) to authenticated;

grant execute on function private.is_lixray_mcp_session() to authenticated;
grant execute on function private.is_interactive_session() to authenticated;
grant execute on function private.is_namespace_member(uuid, uuid) to authenticated;
grant execute on function private.is_namespace_owner(uuid, uuid) to authenticated;
grant execute on function private.can_access_lix(uuid, uuid) to authenticated;

alter default privileges in schema public grant all on tables to postgres, service_role;
alter default privileges in schema public grant all on functions to postgres, service_role;
