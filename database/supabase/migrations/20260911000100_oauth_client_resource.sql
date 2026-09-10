-- One immutable resource per OAuth client. Supabase still owns all token
-- lifecycle operations. Install transactionally: approval enforcement and the
-- token hook must change together.
begin;

-- Quiesce code/consent transactions before copying bindings and invalidating
-- old codes; otherwise an approval could commit between those operations.
lock table auth.oauth_authorizations in access exclusive mode;

-- Deployment policy is operator-owned. Local seed/setup adds loopback aliases;
-- a production migration permits only the production resource.
create table private.oauth_resource_policy (
	resource text primary key check (resource in (
		'https://lixray.com', 'http://127.0.0.1:8787', 'http://localhost:8787'
	))
);
alter table private.oauth_resource_policy enable row level security;
revoke all on private.oauth_resource_policy from public, anon, authenticated, service_role, supabase_auth_admin;
insert into private.oauth_resource_policy values ('https://lixray.com');

create table private.oauth_client_resources (
	client_id uuid primary key references auth.oauth_clients(id) on delete cascade,
	resource text not null check (resource in (
		'https://lixray.com', 'http://127.0.0.1:8787', 'http://localhost:8787'
	)),
	created_at timestamptz not null default clock_timestamp()
);
alter table private.oauth_client_resources enable row level security;
revoke all on private.oauth_client_resources from public, anon, authenticated, service_role, supabase_auth_admin;

-- Preserve only unambiguous, previously proven bindings. The token hook checks
-- the old session binding as well, so older unbound sessions cannot inherit it.
insert into private.oauth_client_resources (client_id, resource)
select client_id, min(resource) from private.oauth_session_resources
where resource in ('https://lixray.com', 'http://127.0.0.1:8787', 'http://localhost:8787')
group by client_id
having count(distinct resource) = 1
	and not exists (
		select 1 from private.oauth_session_resources other
		where other.client_id = oauth_session_resources.client_id
			and other.resource not in ('https://lixray.com', 'http://127.0.0.1:8787', 'http://localhost:8787')
	);

-- Outstanding codes predate the new approval policy. Invalidate those codes,
-- preserving established sessions and consents. A fresh authorization is safe.
update auth.oauth_authorizations set status = 'denied'
where status in ('pending', 'approved');

create function private.bind_oauth_client_resource()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	approved_resource text;
	bound_resource text;
begin
	if new.status <> 'approved' then return new; end if;
	-- Exact allowlist; canonicalize only the documented endpoint aliases.
	approved_resource := case new.resource
		when 'https://lixray.com' then 'https://lixray.com'
		when 'https://lixray.com/mcp' then 'https://lixray.com'
		when 'https://lixray.com/mcp/' then 'https://lixray.com'
		when 'http://127.0.0.1:8787' then 'http://127.0.0.1:8787'
		when 'http://127.0.0.1:8787/mcp' then 'http://127.0.0.1:8787'
		when 'http://localhost:8787' then 'http://localhost:8787'
		when 'http://localhost:8787/mcp' then 'http://localhost:8787'
		else null end;
	if approved_resource is null or new.user_id is null or not exists (
		select 1 from private.oauth_resource_policy where resource = approved_resource
	) then
		raise exception using errcode = '22023', message = 'Unsupported LixRay OAuth resource.';
	end if;
	-- Unique-key conflict serialization makes simultaneous approvals safe.
	insert into private.oauth_client_resources (client_id, resource)
	values (new.client_id, approved_resource) on conflict (client_id) do nothing;
	select resource into bound_resource from private.oauth_client_resources
	where client_id = new.client_id;
	if bound_resource is distinct from approved_resource then
		raise exception using errcode = '22023', message = 'OAuth client is already bound to another resource.';
	end if;
	return new;
end;
$$;
revoke all on function private.bind_oauth_client_resource() from public, anon, authenticated, service_role, supabase_auth_admin;
create trigger lixray_bind_oauth_client_resource
before insert or update on auth.oauth_authorizations
for each row execute function private.bind_oauth_client_resource();

create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	claims jsonb := coalesce(event -> 'claims', '{}'::jsonb) - 'account_id';
	oauth_client_id uuid := nullif(claims ->> 'client_id', '')::uuid;
	oauth_user_id uuid := nullif(event ->> 'user_id', '')::uuid;
	oauth_session_id uuid := nullif(claims ->> 'session_id', '')::uuid;
	oauth_session auth.sessions%rowtype;
	client_binding private.oauth_client_resources%rowtype;
	oauth_resource text;
	canonical_account_id uuid;
begin
	-- Preserve the account identity derived from the active login mapping.
	select login.account_id into canonical_account_id
	from public.account_logins login
	join public.accounts account on account.id = login.account_id
	where login.auth_user_id = oauth_user_id and account.status = 'active';
	if canonical_account_id is not null then
		claims := jsonb_set(claims, '{account_id}', to_jsonb(canonical_account_id::text), true);
	end if;

	-- These claims are derived only from server-owned session data, never from
	-- incoming custom claims or user metadata.
	claims := claims - 'resource' - 'lixray_mcp';
	if oauth_client_id is null then
		return jsonb_build_object('claims', claims);
	end if;

	select * into oauth_session
	from auth.sessions
	where id = oauth_session_id;

	if not found
		or oauth_session.user_id is distinct from oauth_user_id
		or claims ->> 'sub' is distinct from oauth_user_id::text
		or oauth_session.oauth_client_id is distinct from oauth_client_id
		or oauth_session.created_at is null
		or oauth_session.scopes is null
		or oauth_session.scopes is distinct from claims ->> 'scope'
	then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'Invalid OAuth session binding.'
		));
	end if;

	select * into client_binding from private.oauth_client_resources
	where client_id = oauth_client_id;
	if not found then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'OAuth client has no approved LixRay resource.'
		));
	end if;

	-- A client mapping cannot retroactively authorize an older, unrelated
	-- session. Only the previous migration's proven session bindings may bridge
	-- that cutoff. New sessions need no per-session resource lookup or write.
	if oauth_session.created_at < client_binding.created_at and not exists (
		select 1 from private.oauth_session_resources legacy
		where legacy.session_id = oauth_session_id
			and legacy.user_id = oauth_user_id
			and legacy.client_id = oauth_client_id
			and legacy.scopes = oauth_session.scopes
			and legacy.resource = client_binding.resource
	) then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'OAuth session predates client approval. Reconnect the application.'
		));
	end if;
	oauth_resource := client_binding.resource;
	if not exists (select 1 from private.oauth_resource_policy where resource = oauth_resource) then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'OAuth resource is not enabled for this deployment.'
		));
	end if;
	if oauth_resource <> 'https://lixray.com' and coalesce(claims ->> 'iss', '') not in (
		'http://127.0.0.1:54321/auth/v1', 'http://localhost:54321/auth/v1'
	) then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'Local OAuth resource requires a local issuer.'
		));
	end if;

	claims := jsonb_set(claims, '{resource}', to_jsonb(oauth_resource), true);
	claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	return jsonb_build_object('claims', claims);
end;
$$;

revoke all on function private.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;

commit;
