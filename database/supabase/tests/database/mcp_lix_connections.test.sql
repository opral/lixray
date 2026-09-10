begin;

create extension if not exists pgtap with schema extensions;
select plan(13);
insert into private.oauth_resource_policy values ('http://127.0.0.1:8787') on conflict do nothing;

insert into auth.users (
	id, instance_id, aud, role, email, encrypted_password,
	email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
	'20000000-0000-0000-0000-000000000001',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'mcp-owner@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"MCP Owner"}', now(), now()
);

insert into auth.oauth_clients (
	id,
	registration_type,
	redirect_uris,
	grant_types,
	client_name,
	client_type,
	token_endpoint_auth_method
) values (
	'30000000-0000-4000-8000-000000000001',
	'dynamic',
	'http://127.0.0.1:45678/callback',
	'authorization_code refresh_token',
	'Codex',
	'public',
	'none'
);

insert into auth.oauth_authorizations (
	id,
	authorization_id,
	client_id,
	user_id,
	redirect_uri,
	scope,
	resource,
	status,
	expires_at,
	approved_at
) values (
	'31000000-0000-4000-8000-000000000001',
	'codex-local-authorization',
	'30000000-0000-4000-8000-000000000001',
	'20000000-0000-0000-0000-000000000001',
	'http://127.0.0.1:45678/callback',
	'openid email profile',
	'http://127.0.0.1:8787/mcp',
	'approved',
	now() + interval '5 minutes',
	now()
);

insert into auth.sessions (id, user_id, oauth_client_id, scopes)
values (
	'32000000-0000-4000-8000-000000000001',
	'20000000-0000-0000-0000-000000000001',
	'30000000-0000-4000-8000-000000000001',
	'openid email profile'
);

update auth.sessions set created_at = clock_timestamp() where id = '32000000-0000-4000-8000-000000000001';

select is(
	private.custom_access_token_hook(
		jsonb_build_object(
			'user_id', '20000000-0000-0000-0000-000000000001',
			'authentication_method', 'oauth_provider/authorization_code',
			'claims', jsonb_build_object(
				'client_id', '30000000-0000-4000-8000-000000000001',
				'sub', '20000000-0000-0000-0000-000000000001',
				'session_id', '32000000-0000-4000-8000-000000000001',
				'scope', 'openid email profile',
				'iss', 'http://127.0.0.1:54321/auth/v1'
			)
		)
	) -> 'claims' ->> 'resource',
	'http://127.0.0.1:8787',
	'the local Codex client receives the isolated local resource'
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);

select lives_ok(
	$$select * from public.bootstrap_personal_namespace()$$,
	'the owner bootstraps a personal namespace'
);

reset role;
select lives_ok(
	$$insert into public.lixes (id, namespace_id, name, slug)
	values (
		'40000000-0000-0000-0000-000000000001',
		(select primary_namespace_id from public.accounts where id='20000000-0000-0000-0000-000000000001'),
		'MCP Repository',
		'mcp-repository'
	)$$,
	'the owner explicitly creates a repository to connect'
);
set local role authenticated;

select throws_ok(
	$$select public.record_mcp_lix_connection(
		'40000000-0000-0000-0000-000000000001',
		'active_branch_id'
	)$$,
	'P0001',
	'LixRay MCP session required',
	'an interactive session cannot forge the MCP handshake'
);

select throws_ok(
	$$insert into public.mcp_lix_connections (
		account_id, lix_id, oauth_client_id, last_tool
	) values (
		'20000000-0000-0000-0000-000000000001',
		'40000000-0000-0000-0000-000000000001',
		'forged-client',
		'active_branch_id'
	)$$,
	'42501',
	null,
	'direct writes are not granted to authenticated clients'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated","client_id":"codex-local","resource":"https://lixray.com","lixray_mcp":true}',
	true
);

select lives_ok(
	$$select public.record_mcp_lix_connection(
		'40000000-0000-0000-0000-000000000001',
		'active_branch_id'
	)$$,
	'a valid LixRay MCP session records the handshake'
);

select throws_ok(
	$$select * from public.create_lix_share_token(
		'40000000-0000-0000-0000-000000000001'
	)$$,
	'P0001',
	'Interactive session required',
	'an MCP bearer cannot mint a transferable share token'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated","client_id":"codex-local","iss":"http://127.0.0.1:54321/auth/v1","resource":"http://127.0.0.1:8787","lixray_mcp":true}',
	true
);

select is(
	private.is_lixray_mcp_session(),
	true,
	'a local issuer accepts the isolated local MCP resource'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated","client_id":"codex-local","iss":"https://project.supabase.co/auth/v1","resource":"http://127.0.0.1:8787","lixray_mcp":true}',
	true
);

select is(
	private.is_lixray_mcp_session(),
	false,
	'a production issuer rejects a local MCP resource'
);

reset role;

select is(
	(select count(*)
		from public.mcp_lix_connections
		where account_id = '20000000-0000-0000-0000-000000000001'),
	1::bigint,
	'exactly one connection row is stored'
);

select results_eq(
	$$select oauth_client_id, last_tool
		from public.mcp_lix_connections
		where account_id = '20000000-0000-0000-0000-000000000001'$$,
	$$values ('codex-local'::text, 'active_branch_id'::text)$$,
	'the server derives the OAuth client and stores only connection metadata'
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);

select is(
	(select count(*) from public.mcp_lix_connections),
	1::bigint,
	'the owning interactive session can observe its connection'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
	true
);

select is(
	(select count(*) from public.mcp_lix_connections),
	0::bigint,
	'another interactive user cannot observe the connection'
);

select * from finish();
rollback;
