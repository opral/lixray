-- Repository slugs derive from names. "repo-<uuid>" is only ever a tombstone:
-- deleting a repository hands its slug over to the next repository with that
-- name. Names are unique per namespace at the slug level (the squat key, which
-- ignores hyphens, still applies), and a clash is rejected up front instead of
-- being hidden behind a generated slug.

create or replace function private.repository_slug(p_name text)
returns text language sql immutable set search_path to '' as $$
	select coalesce(
		nullif(
			btrim(left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), 100), '-'),
			''
		),
		'repository'
	)
$$;

create or replace function private.repository_slug_taken(p_namespace_id uuid, p_slug text, p_exclude_id uuid default null)
returns boolean language sql stable security definer set search_path to '' as $$
	select exists (
		select 1 from public.lixes repository
		where repository.namespace_id = p_namespace_id
			and repository.deleted_at is null
			and repository.id is distinct from p_exclude_id
			and (repository.slug = p_slug or repository.slug_squat_key = replace(p_slug, '-', ''))
	)
$$;

-- Backfill before the trigger exists: tombstones release their names, and live
-- repositories that were stuck with a generated slug take their name's slug
-- where it is free (oldest first, so the first claimant keeps it).
update public.lixes set slug = 'repo-' || id::text
where deleted_at is not null and slug <> 'repo-' || id::text;
do $$
declare
	repository record;
	candidate text;
begin
	for repository in
		select id, namespace_id, name from public.lixes
		where deleted_at is null and slug ~ '^repo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		order by created_at asc, id asc
	loop
		candidate := private.repository_slug(repository.name);
		if not private.repository_slug_taken(repository.namespace_id, candidate, repository.id) then
			update public.lixes set slug = candidate where id = repository.id;
		end if;
	end loop;
end;
$$;

-- The slug follows the name on rename, becomes the tombstone on delete, and is
-- never chosen by a client directly. Clashes raise unique_violation so
-- PostgREST answers 409.
create function private.derive_repository_slug()
returns trigger language plpgsql set search_path to '' as $$
begin
	if new.deleted_at is not null then
		new.slug := 'repo-' || new.id::text;
		return new;
	end if;
	if tg_op = 'UPDATE' and old.deleted_at is null and new.name is not distinct from old.name then
		new.slug := old.slug;
		return new;
	end if;
	if tg_op = 'UPDATE' or new.slug is null then
		new.slug := private.repository_slug(new.name);
	end if;
	if private.repository_slug_taken(new.namespace_id, new.slug, new.id) then
		raise exception 'A repository named "%" already exists in this namespace', btrim(new.name)
			using errcode = '23505';
	end if;
	return new;
end;
$$;
create trigger lixes_derive_slug before insert or update on public.lixes
	for each row execute function private.derive_repository_slug();

-- Creation derives the slug and rejects a taken name before any storage is
-- created: the gateway's authorization step now checks the name too.
drop function public.authorize_hosted_lix_creation(uuid,uuid);
create function public.authorize_hosted_lix_creation(p_account_id uuid, p_namespace_id uuid default null, p_name text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare target_namespace uuid;
begin
 if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Gateway authentication required'; end if;
 select coalesce(p_namespace_id, account.primary_namespace_id) into target_namespace
 from public.accounts account where account.id = p_account_id and account.status = 'active';
 if target_namespace is null or not private.is_namespace_member(target_namespace, p_account_id) then
  raise exception 'Namespace membership required' using errcode = '42501';
 end if;
 if p_name is not null and private.repository_slug_taken(target_namespace, private.repository_slug(p_name)) then
  raise exception 'A repository named "%" already exists in this namespace', btrim(p_name) using errcode = '23505';
 end if;
 return target_namespace;
end;
$$;
revoke all on function public.authorize_hosted_lix_creation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.authorize_hosted_lix_creation(uuid,uuid,text) to service_role;

create or replace function public.register_hosted_lix(p_lix_id uuid, p_account_id uuid, p_namespace_id uuid default null, p_name text default 'Shared repository')
returns void language plpgsql security definer set search_path to '' as $$
declare
 target_namespace uuid;
 recorded_account uuid;
 existing_repository public.lixes%rowtype;
 normalized_name text := btrim(coalesce(p_name, ''));
begin
 if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Gateway authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hosted-lix:' || p_lix_id::text, 0));
 select receipt.account_id into recorded_account from private.hosted_lix_creations receipt where receipt.lix_id = p_lix_id;
 select * into existing_repository from public.lixes where id = p_lix_id;
 if recorded_account is not null then
  if recorded_account <> p_account_id or existing_repository.id is null or existing_repository.deleted_at is not null
     or not exists(select 1 from public.accounts where id=p_account_id and status='active') then
   raise exception 'Repository creation receipt is no longer available';
  end if;
  -- First successful registration wins. A retry never renames or transfers data.
  return;
 end if;
 if existing_repository.id is not null then raise exception 'Repository ID already registered'; end if;
 target_namespace := public.authorize_hosted_lix_creation(p_account_id, p_namespace_id);
 if length(normalized_name) not between 1 and 80 then raise exception 'Repository name must be 1–80 characters'; end if;
 insert into public.lixes(id, namespace_id, name, slug, visibility)
 values (p_lix_id, target_namespace, normalized_name, private.repository_slug(normalized_name), 'private');
 insert into private.hosted_lix_creations(lix_id, account_id) values (p_lix_id, p_account_id);
end;
$$;

-- The New repository dialog checks a name as it is typed.
create function public.is_repository_name_available(p_namespace_id uuid, p_name text)
returns boolean language sql stable security definer set search_path to '' as $$
	select private.is_namespace_member(p_namespace_id)
		and not private.repository_slug_taken(p_namespace_id, private.repository_slug(p_name))
$$;
revoke all on function public.is_repository_name_available(uuid,text) from public,anon;
grant execute on function public.is_repository_name_available(uuid,text) to authenticated;
