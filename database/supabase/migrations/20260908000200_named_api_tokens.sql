-- Preserve existing credentials while allowing independently deletable tokens.
create function private.random_api_token_name()
returns text language sql volatile set search_path to '' as $$
 select (array['happy','calm','brave','bright','clever','cozy','eager','gentle','jolly','kind','lively','lucky','merry','nimble','patient','playful','proud','quiet','rapid','sleepy','smiling','snowy','sunny','swift','tiny','warm','wild','wise','witty','bold','curious','friendly'])[1 + floor(random()*32)::int]
 || '-' || (array['elephant','otter','panda','fox','owl','tiger','rabbit','dolphin','falcon','koala','badger','beaver','bison','butterfly','camel','deer','finch','giraffe','heron','iguana','jaguar','lemur','lion','lynx','moose','penguin','puffin','raven','seal','sparrow','turtle','whale'])[1 + floor(random()*32)::int];
$$;
revoke all on function private.random_api_token_name() from public, anon, authenticated;
alter table private.api_tokens
 drop constraint api_tokens_pkey,
 add column id uuid not null default gen_random_uuid(),
 add column name text not null default private.random_api_token_name(),
 add primary key (id),
 add unique (account_id, lix_id, name);

drop function public.get_api_token(uuid);
drop function public.generate_api_token(uuid);
drop function public.revoke_api_token(uuid);

create function public.list_api_tokens(p_lix_id uuid)
returns table(id uuid, name text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
begin
 if private.current_account_id() is null then raise exception 'Authentication required'; end if;
 if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
 return query select t.id,t.name,t.created_at,t.expires_at from private.api_tokens t
 where t.account_id = private.current_account_id() and t.lix_id = p_lix_id
 order by t.created_at desc,t.id;
end;
$$;

create function public.generate_api_token(p_lix_id uuid)
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
 if not exists (
  select 1 from public.lixes lix where lix.id=p_lix_id and lix.deleted_at is null
  and private.can_access_lix_or_unseeded(lix.id,lix.namespace_id,owner_id)
 ) then raise exception 'Repository access required'; end if;
 -- Serialize name selection, including concurrent requests for the same account.
 perform 1 from public.accounts where accounts.id=owner_id for update;
 while exists(select 1 from private.api_tokens t where t.account_id=owner_id and t.lix_id=p_lix_id and t.name=token_name) loop
  suffix := suffix + 1;
  token_name := base_name || '-' || suffix::text;
 end loop;
 secret := 'lixray_pat_' || encode(extensions.gen_random_bytes(32),'hex');
 insert into private.api_tokens(id,account_id,lix_id,name,token_hash,created_at,expires_at)
 values(token_id,owner_id,p_lix_id,token_name,extensions.digest(secret,'sha256'),issued_at,issued_at+interval '1 year');
 return query select t.id,t.name,secret,t.created_at,t.expires_at from private.api_tokens t where t.id=token_id;
end;
$$;

create function public.delete_api_token(p_lix_id uuid,p_token_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
 if private.current_account_id() is null then raise exception 'Authentication required'; end if;
 if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
 delete from private.api_tokens where id=p_token_id and lix_id=p_lix_id and account_id=private.current_account_id();
end;
$$;
revoke all on function public.list_api_tokens(uuid),public.generate_api_token(uuid),public.delete_api_token(uuid,uuid) from public,anon;
grant execute on function public.list_api_tokens(uuid),public.generate_api_token(uuid),public.delete_api_token(uuid,uuid) to authenticated;
