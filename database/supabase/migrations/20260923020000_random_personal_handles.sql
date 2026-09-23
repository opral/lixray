-- New personal accounts receive an unrelated, human-readable username.
-- Existing usernames and profile display names are unchanged.

-- A namespace may keep former handles as redirects, but has only one current
-- handle. The squat-key index still permits only one owner of each spelling.
alter table public.handles drop constraint handles_namespace_id_key;
create unique index handles_one_active_per_namespace
on public.handles (namespace_id) where state = 'active';

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
	profile_name text;
	avatar_uri text;
	profile_document jsonb;
	claimed_handle text;
	attempt integer;
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

	-- A readable, unrelated username avoids exposing the user's real name or email.
	-- The handle pool is shared with organizations and reserved names.
	for attempt in 1..20 loop
		claimed_handle :=
			(array['brisk', 'calm', 'clever', 'curious', 'gentle', 'happy', 'kind', 'mellow', 'quiet', 'witty'])[1 + floor(random() * 10)::int]
			|| '-'
			|| (array['badger', 'falcon', 'fox', 'heron', 'otter', 'panda', 'raven', 'robin', 'turtle', 'whale'])[1 + floor(random() * 10)::int]
			|| '-' || (100000 + floor(random() * 900000)::int)::text;
		perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));
		exit when not exists (
			select 1 from public.handles
			where squat_key = replace(claimed_handle, '-', '')
		);
	end loop;
	if exists (
		select 1 from public.handles
		where squat_key = replace(claimed_handle, '-', '')
	) then raise exception 'Could not allocate a username'; end if;

	insert into public.namespaces (name) values (profile_name)
	returning id into created_namespace_id;
	insert into public.handles (handle, namespace_id) values (claimed_handle, created_namespace_id);
	insert into public.namespace_profiles (namespace_id, document)
	values (created_namespace_id, profile_document);
	update public.accounts set primary_namespace_id = created_namespace_id
	where id = current_account_id and primary_namespace_id is null;
	if not found then raise exception 'Account already has a personal namespace'; end if;
	return query select created_namespace_id, profile_name, claimed_handle,
        null::uuid, null::text, null::text, true;
end;
$$;

create or replace function public.rename_personal_handle(p_handle text)
returns text
language plpgsql security definer
set search_path to ''
as $$
declare
  account_id uuid := private.current_account_id();
  personal_namespace_id uuid;
  current_handle text;
  requested_handle text := lower(btrim(coalesce(p_handle, '')));
begin
  if account_id is null then raise exception 'Authentication required'; end if;
  if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
  select account.primary_namespace_id into personal_namespace_id
  from public.accounts account where account.id = account_id;
  if personal_namespace_id is null then raise exception 'Personal profile not found'; end if;
  if char_length(requested_handle) < 3 or char_length(requested_handle) > 39
    or requested_handle !~ '^[a-z0-9](?:-?[a-z0-9]){0,38}$' then
    raise exception 'Username must be 3–39 lowercase letters, numbers, or single hyphens';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('personal-namespace:' || account_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(requested_handle, '-', ''), 0));
  select handle.handle into current_handle
  from public.handles handle
  where handle.namespace_id = personal_namespace_id and handle.state = 'active'
  for update;
  if current_handle is null then raise exception 'Personal username not found'; end if;
  if requested_handle = current_handle then return current_handle; end if;
  if exists (
    select 1 from public.handles handle
    where handle.squat_key = replace(requested_handle, '-', '')
      and handle.state <> 'redirect'
  ) then raise exception 'This username is unavailable'; end if;
  -- A new claim takes precedence over a former owner's redirect. Removing the
  -- row and creating the active row happen in the same transaction.
  delete from public.handles
  where squat_key = replace(requested_handle, '-', '') and state = 'redirect';
  update public.handles
  set state = 'redirect', reason = 'former personal username'
  where namespace_id = personal_namespace_id and state = 'active';
  insert into public.handles (handle, namespace_id)
  values (requested_handle, personal_namespace_id);
  return requested_handle;
exception when unique_violation then
  raise exception 'This username is unavailable';
end;
$$;

revoke all on function public.rename_personal_handle(text) from public;
grant execute on function public.rename_personal_handle(text) to authenticated;

-- Resolve former namespace handles only while their redirect row remains.
-- A reclaimed handle replaces that row atomically and resolves to its new owner.
create or replace function public.resolve_public_lix_by_route(
  p_namespace_handle text, p_lix_slug text, p_path text default null
)
returns table(
  namespace_id uuid, namespace_name text, namespace_handle text,
  lix_id uuid, lix_name text, lix_slug text, can_edit boolean,
  role public.lix_role, visibility public.lix_visibility, path_public boolean
)
language sql stable security definer set search_path to ''
as $$
  select namespace.id, namespace.name, canonical_handle.handle,
    repository.id, repository.name, repository.slug,
    private.can_access_lix(repository.id), member.role, repository.visibility,
    private.is_lix_path_public(repository.id, p_path)
  from public.lixes repository
  join public.namespaces namespace on namespace.id = repository.namespace_id
  join public.handles requested_handle
    on requested_handle.namespace_id = namespace.id
    and requested_handle.state in ('active', 'redirect')
  join public.handles canonical_handle
    on canonical_handle.namespace_id = namespace.id
    and canonical_handle.state = 'active'
  left join public.lix_members member
    on member.lix_id = repository.id and member.account_id = private.current_account_id()
  where requested_handle.handle = lower(btrim(coalesce(p_namespace_handle, '')))
    and repository.slug = lower(btrim(coalesce(p_lix_slug, '')))
    and repository.deleted_at is null
    and (member.account_id is not null or repository.visibility = 'public'
      or private.is_lix_path_public(repository.id, p_path));
$$;
