-- Account tokens replace repository tokens. Never upgrade a leaked or delegated
-- repository credential to account-wide permissions.
delete from private.api_tokens;
drop function public.list_api_tokens(uuid);
drop function public.generate_api_token(uuid);
drop function public.delete_api_token(uuid,uuid);
alter table private.api_tokens drop column lix_id cascade;
alter table private.api_tokens add unique(account_id,name);

create function public.list_api_tokens()
returns table(id uuid, name text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
begin
 if private.current_account_id() is null then raise exception 'Authentication required'; end if;
 if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
 return query select t.id,t.name,t.created_at,t.expires_at from private.api_tokens t
 where t.account_id = private.current_account_id()
 order by t.created_at desc,t.id;
end;
$$;

create function public.generate_api_token()
returns table(id uuid, name text, token text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path to '' as $$
declare
 owner_id uuid := private.current_account_id();
 token_id uuid := gen_random_uuid();
 secret text;
 base_name text := private.random_api_token_name();
 token_name text := base_name;
 suffix integer := 1;
 issued_at timestamptz := statement_timestamp();
begin
 if owner_id is null then raise exception 'Authentication required'; end if;
 if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
 -- Serialize name selection, including concurrent requests for the same account.
 perform 1 from public.accounts where accounts.id=owner_id for update;
 while exists(select 1 from private.api_tokens t where t.account_id=owner_id and t.name=token_name) loop
  suffix := suffix + 1;
  token_name := base_name || '-' || suffix::text;
 end loop;
 secret := 'lixray_pat_' || encode(extensions.gen_random_bytes(32),'hex');
 insert into private.api_tokens(id,account_id,name,token_hash,created_at,expires_at)
 values(token_id,owner_id,token_name,extensions.digest(secret,'sha256'),issued_at,issued_at+interval '1 year');
 return query select t.id,t.name,secret,t.created_at,t.expires_at from private.api_tokens t where t.id=token_id;
end;
$$;

create function public.delete_api_token(p_token_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
 if private.current_account_id() is null then raise exception 'Authentication required'; end if;
 if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
 delete from private.api_tokens where id=p_token_id and account_id=private.current_account_id();
end;
$$;
revoke all on function public.list_api_tokens(),public.generate_api_token(),public.delete_api_token(uuid) from public,anon;
grant execute on function public.list_api_tokens(),public.generate_api_token(),public.delete_api_token(uuid) to authenticated;

create or replace function public.authorize_api_token(p_token text, p_lix_id uuid)
returns table(account_id uuid, kind text, profile_uri text, name text, allowed boolean)
language sql stable security definer
set search_path to ''
as $$
	select account.id, account.kind,
		'https://lixray.com/profile/' || namespace.id::text,
		coalesce(nullif(btrim(profile.document #>> '{name,full}'), ''), namespace.name, 'Account'),
		p_lix_id is null or exists (
			select 1 from public.lixes lix
			where lix.id = p_lix_id and lix.deleted_at is null
				and (
                    exists(select 1 from public.lix_members m where m.lix_id=lix.id and m.account_id=account.id)
                    or (not exists(select 1 from public.lix_members m where m.lix_id=lix.id)
                        and (coalesce(account.primary_namespace_id=lix.namespace_id,false)
                            or exists(select 1 from public.namespace_members m where m.namespace_id=lix.namespace_id and m.account_id=account.id)))
                )
		)
	from private.api_tokens token
	join public.accounts account on account.id = token.account_id and account.status = 'active'
	left join public.namespaces namespace on namespace.id = account.primary_namespace_id
	left join public.namespace_profiles profile on profile.namespace_id = namespace.id
	where p_token ~ '^lixray_pat_[0-9a-f]{64}$'
		and token.token_hash = extensions.digest(p_token, 'sha256')
		and token.expires_at > statement_timestamp();
$$;

-- Reuse the existing user RPCs and their permission checks for API-token calls.
-- The actor is derived only from the secret, never supplied by the caller.
create function public.api_token_sharing(p_token text, p_operation text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
 actor uuid;
 login_id uuid;
 previous_claims text := current_setting('request.jwt.claims', true);
 result jsonb;
begin
 select a.account_id into actor from public.authorize_api_token(p_token,null) a where a.allowed;
 if actor is null then raise exception 'Invalid or expired API token'; end if;
 select auth_user_id into login_id from public.account_logins where account_id=actor order by created_at limit 1;
 if login_id is null then raise exception 'Account login unavailable'; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',login_id,'role','authenticated')::text,true);
 case p_operation
  when 'list_accessible_lixes' then
   select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into result from public.list_accessible_lixes() r;
  when 'list_lix_publications' then
   select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into result from public.list_lix_publications((p_args->>'p_lix_id')::uuid) r;
  when 'publish_lix_resource' then
   perform public.publish_lix_resource((p_args->>'p_lix_id')::uuid,p_args->>'p_path',(p_args->>'p_kind')::public.lix_publication_kind);
  when 'unpublish_lix_resource' then
   perform public.unpublish_lix_resource((p_args->>'p_lix_id')::uuid,p_args->>'p_path',(p_args->>'p_kind')::public.lix_publication_kind);
  else raise exception 'Unsupported sharing operation';
 end case;
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
 return result;
exception when others then
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
 raise;
end;
$$;
revoke all on function public.api_token_sharing(text,text,jsonb) from public;
grant execute on function public.api_token_sharing(text,text,jsonb) to anon,authenticated;

-- Restore the original publication boundary in previews that applied the
-- abandoned desktop OAuth implementation. Account PATs use the verified wrapper.
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

