-- Repository storage is created/opened/deleted only through /lix/v1.
-- Database registration records a successful protocol creation, never adopts an ID.
revoke insert on public.lixes from authenticated;
drop function public.resolve_lix_provision_mode(uuid,text);
drop trigger guard_lix_storage_provision_mode on public.lixes;
drop function private.guard_lix_storage_provision_mode();
alter table public.lixes drop column storage_provision_mode;
drop function public.delete_lix(uuid);
drop function public.register_hosted_lix(uuid,uuid);

create function public.authorize_hosted_lix_creation(p_account_id uuid, p_namespace_id uuid default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare target_namespace uuid;
begin
 if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Gateway authentication required'; end if;
 select coalesce(p_namespace_id, account.primary_namespace_id) into target_namespace
 from public.accounts account where account.id = p_account_id and account.status = 'active';
 if target_namespace is null or not private.is_namespace_member(target_namespace, p_account_id) then
  raise exception 'Namespace membership required' using errcode = '42501';
 end if;
 return target_namespace;
end;
$$;

create function public.register_hosted_lix(p_lix_id uuid, p_account_id uuid, p_namespace_id uuid default null, p_name text default 'Shared repository')
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
 values (p_lix_id, target_namespace, normalized_name, 'repo-' || p_lix_id::text, 'private');
 insert into private.hosted_lix_creations(lix_id, account_id) values (p_lix_id, p_account_id);
end;
$$;

-- Retained admin membership authorizes retries even after deleted_at is set.
create function public.authorize_hosted_lix_deletion(p_lix_id uuid, p_account_id uuid)
returns boolean language plpgsql security definer set search_path to '' as $$
declare already_deleted boolean;
begin
 if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Gateway authentication required'; end if;
 select lix.deleted_at is not null into already_deleted
 from public.lixes lix join public.lix_members member on member.lix_id=lix.id
 join public.accounts account on account.id=member.account_id
 where lix.id=p_lix_id and member.account_id=p_account_id and member.role='admin' and account.status='active';
 if not found then raise exception 'Repository admin access required' using errcode='42501'; end if;
 return already_deleted;
end;
$$;

create function public.delete_hosted_lix(p_lix_id uuid, p_account_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
 perform public.authorize_hosted_lix_deletion(p_lix_id, p_account_id);
 update public.lixes set deleted_at=coalesce(deleted_at,now()) where id=p_lix_id;
end;
$$;
revoke all on function public.authorize_hosted_lix_creation(uuid,uuid), public.register_hosted_lix(uuid,uuid,uuid,text), public.authorize_hosted_lix_deletion(uuid,uuid), public.delete_hosted_lix(uuid,uuid) from public,anon,authenticated;
grant execute on function public.authorize_hosted_lix_creation(uuid,uuid), public.register_hosted_lix(uuid,uuid,uuid,text), public.authorize_hosted_lix_deletion(uuid,uuid), public.delete_hosted_lix(uuid,uuid) to service_role;

-- Account onboarding creates its namespace, not a phantom repository.
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
	return query select created_namespace_id, profile_name, claimed_handle,
        null::uuid, null::text, null::text, true;
end;
$$;

