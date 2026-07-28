-- Bind MCP access tokens to the resource requested during OAuth authorization.
-- This keeps local development tokens distinct from production tokens even
-- when both environments use the same Codex installation.

create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
	oauth_resource text;
begin
	if coalesce(claims ->> 'client_id', '') <> '' then
		select case
			when oauth_client.client_name = 'Codex LixRay_Dev'
				then 'http://127.0.0.1:8787'
			else 'https://lixray.com'
		end
		into oauth_resource
		from auth.oauth_clients as oauth_client
		where oauth_client.id = (claims ->> 'client_id')::uuid
			and oauth_client.deleted_at is null;

		-- Existing production clients predate environment-specific resources.
		oauth_resource := coalesce(nullif(oauth_resource, ''), 'https://lixray.com');
		claims := jsonb_set(claims, '{resource}', to_jsonb(oauth_resource), true);
		claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	end if;
	return jsonb_build_object('claims', claims);
end;
$$;

revoke all on function private.custom_access_token_hook(jsonb)
	from public, anon, authenticated;
grant execute on function private.custom_access_token_hook(jsonb)
	to supabase_auth_admin;

create or replace function private.is_lixray_mcp_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce((select auth.jwt() ->> 'lixray_mcp')::boolean, false)
		and nullif((select auth.jwt() ->> 'client_id'), '') is not null
		and (
			(select auth.jwt() ->> 'resource') = 'https://lixray.com'
			or (
				(select auth.jwt() ->> 'iss') in (
					'http://127.0.0.1:54321/auth/v1',
					'http://localhost:54321/auth/v1'
				)
				and (select auth.jwt() ->> 'resource') in (
					'http://127.0.0.1:8787',
					'http://localhost:8787'
				)
			)
		);
$$;

revoke all on function private.is_lixray_mcp_session() from public, anon;
grant execute on function private.is_lixray_mcp_session() to authenticated;
