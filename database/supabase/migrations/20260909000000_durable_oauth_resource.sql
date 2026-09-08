-- OAuth authorization rows are consumed by GoTrue at code exchange. Resource
-- permissions belong to the resulting session and must survive token rotation.
create table private.oauth_session_resources (
	session_id uuid primary key references auth.sessions(id) on delete cascade,
	user_id uuid not null,
	client_id uuid not null,
	authorization_id uuid not null unique,
	resource text not null check (btrim(resource) <> ''),
	scopes text not null,
	created_at timestamptz not null default now()
);

alter table private.oauth_session_resources enable row level security;
revoke all on private.oauth_session_resources from public, anon, authenticated, service_role, supabase_auth_admin;

comment on table private.oauth_session_resources is
	'Immutable OAuth resource binding, written only by the token hook and deleted with its Supabase session.';

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
	binding private.oauth_session_resources%rowtype;
	candidates auth.oauth_authorizations[];
	selected_authorization auth.oauth_authorizations%rowtype;
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
		or oauth_session.scopes is null
		or oauth_session.scopes is distinct from claims ->> 'scope'
	then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'Invalid OAuth session binding.'
		));
	end if;

	select * into binding
	from private.oauth_session_resources
	where session_id = oauth_session_id;

	if not found then
		-- Never repair an old/refresh session from another login transaction.
		if event ->> 'authentication_method' is distinct from 'oauth_provider/authorization_code' then
			return jsonb_build_object('error', jsonb_build_object(
				'http_code', 403, 'message', 'OAuth resource binding missing. Reconnect the application.'
			));
		end if;

		-- GoTrue v2.195.0 locks the exact approved authorization, creates the
		-- session, calls this hook, then deletes that authorization in the same
		-- transaction. The actual row MUST be in this candidate set. A singleton
		-- therefore identifies it exactly, without choosing the latest grant.
		-- Count and selection share one snapshot. Do not filter by expiry, scope,
		-- or resource: excluding the actual row could select a different grant.
		-- If Supabase changes this contract, the HTTP integration test must fail.
		select array_agg(a) into candidates
		from auth.oauth_authorizations as a
		where a.user_id = oauth_user_id
			and a.client_id = oauth_client_id
			and a.status = 'approved';

		if coalesce(cardinality(candidates), 0) <> 1 then
			return jsonb_build_object('error', jsonb_build_object(
				'http_code', 403, 'message', 'OAuth authorization binding is missing or ambiguous.'
			));
		end if;
		selected_authorization := candidates[1];

		oauth_resource := regexp_replace(
			regexp_replace(btrim(coalesce(selected_authorization.resource, '')), '/+$', ''),
			'/mcp$', ''
		);
		if oauth_resource = '' or selected_authorization.scope is distinct from oauth_session.scopes then
			return jsonb_build_object('error', jsonb_build_object(
				'http_code', 403, 'message', 'Invalid OAuth authorization resource or scopes.'
			));
		end if;

		insert into private.oauth_session_resources (
			session_id, user_id, client_id, authorization_id, resource, scopes
		) values (
			oauth_session_id, oauth_user_id, oauth_client_id,
			selected_authorization.id, oauth_resource, oauth_session.scopes
		) returning * into binding;
	end if;

	if binding.user_id is distinct from oauth_user_id
		or binding.client_id is distinct from oauth_client_id
		or binding.scopes is distinct from oauth_session.scopes
	then
		return jsonb_build_object('error', jsonb_build_object(
			'http_code', 403, 'message', 'Invalid OAuth session resource binding.'
		));
	end if;

	claims := jsonb_set(claims, '{resource}', to_jsonb(binding.resource), true);
	claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	return jsonb_build_object('claims', claims);
end;
$$;

revoke all on function private.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;
