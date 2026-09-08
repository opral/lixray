begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values ('52000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'resource-test@example.com', '{}', '{}');
insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_type, token_endpoint_auth_method)
values ('53000000-0000-4000-8000-000000000001', 'dynamic', 'http://127.0.0.1/callback',
	'authorization_code,refresh_token', 'public', 'none');
insert into auth.sessions (id, user_id, oauth_client_id, scopes)
values ('54000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001',
	'53000000-0000-4000-8000-000000000001', 'openid offline_access');
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status, approved_at)
values ('55000000-0000-4000-8000-000000000001', 'resource-test', '53000000-0000-4000-8000-000000000001',
	'52000000-0000-4000-8000-000000000001', 'http://127.0.0.1/callback',
	'openid offline_access', 'https://lixray.com/mcp/', 'approved', now());

create function pg_temp.token_event(method text default 'token_refresh', patch jsonb default '{}')
returns jsonb language sql as $$
	select jsonb_build_object(
		'user_id', '52000000-0000-4000-8000-000000000001',
		'authentication_method', method,
		'claims', jsonb_build_object(
			'sub', '52000000-0000-4000-8000-000000000001',
			'client_id', '53000000-0000-4000-8000-000000000001',
			'session_id', '54000000-0000-4000-8000-000000000001',
			'scope', 'openid offline_access'
		) || patch
	);
$$;

select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403',
	'a refresh cannot bootstrap a missing binding even when an approved authorization exists');
select is((select count(*) from private.oauth_session_resources), 0::bigint, 'rejected refresh leaves no binding');
select is(private.custom_access_token_hook(pg_temp.token_event('oauth_provider/authorization_code', '{"scope":"openid"}')) #>> '{error,http_code}', '403',
	'claims cannot change the session scopes');
select is(private.custom_access_token_hook(pg_temp.token_event('oauth_provider/authorization_code', '{"sub":"52000000-0000-4000-8000-000000000002"}')) #>> '{error,http_code}', '403',
	'claims cannot change the session user');
select is(private.custom_access_token_hook(pg_temp.token_event('oauth_provider/authorization_code', '{"client_id":"53000000-0000-4000-8000-000000000002"}')) #>> '{error,http_code}', '403',
	'claims cannot change the session client');

-- Include a different-resource, different-scope, expired approved row. None of
-- those properties may exclude a candidate and accidentally select another.
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status, created_at, expires_at, approved_at)
values ('55000000-0000-4000-8000-000000000002', 'other-resource-test', '53000000-0000-4000-8000-000000000001',
	'52000000-0000-4000-8000-000000000001', 'http://127.0.0.1/callback', 'openid',
	null, 'approved', now() - interval '1 hour', now() - interval '30 minutes', now());
select is(private.custom_access_token_hook(pg_temp.token_event('oauth_provider/authorization_code')) #>> '{error,http_code}', '403',
	'ambiguous approved authorizations fail closed even if one is expired or has different scopes or no resource');
delete from auth.oauth_authorizations where id = '55000000-0000-4000-8000-000000000002';

select is(private.custom_access_token_hook(pg_temp.token_event('oauth_provider/authorization_code', '{"resource":"https://attacker.example"}')) #>> '{claims,resource}', 'https://lixray.com',
	'the hook binds the exact authorization and ignores incoming resource claims');
select is((select authorization_id::text from private.oauth_session_resources), '55000000-0000-4000-8000-000000000001',
	'the binding records the exact original authorization');

delete from auth.oauth_authorizations where id = '55000000-0000-4000-8000-000000000001';
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{claims,resource}', 'https://lixray.com',
	'refresh retains the resource after authorization deletion');
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{claims,lixray_mcp}', 'true',
	'repeated refresh retains MCP eligibility');

insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status)
values ('55000000-0000-4000-8000-000000000003', 'new-resource-test', '53000000-0000-4000-8000-000000000001',
	'52000000-0000-4000-8000-000000000001', 'http://127.0.0.1/callback', 'openid offline_access',
	'http://127.0.0.1:8787/mcp', 'approved');
select is(private.custom_access_token_hook(pg_temp.token_event('token_refresh', '{"resource":"http://127.0.0.1:8787"}')) #>> '{claims,resource}', 'https://lixray.com',
	'a later login and incoming claims cannot rebind an established session');
select is((select count(*) from private.oauth_session_resources), 1::bigint, 'refresh does not duplicate the binding');

select ok(not has_table_privilege('anon', 'private.oauth_session_resources', 'SELECT'), 'anonymous users cannot read grants');
select ok(not has_table_privilege('authenticated', 'private.oauth_session_resources', 'SELECT,INSERT,UPDATE,DELETE'), 'users cannot read or forge grants');
select ok(not has_table_privilege('service_role', 'private.oauth_session_resources', 'SELECT,INSERT,UPDATE,DELETE'), 'service API cannot access private grants');
select ok(not has_table_privilege('supabase_auth_admin', 'private.oauth_session_resources', 'INSERT,UPDATE,DELETE'), 'Auth must write bindings through the hook');
select ok(not has_function_privilege('authenticated', 'private.custom_access_token_hook(jsonb)', 'EXECUTE'), 'users cannot invoke the token hook');
select is(private.custom_access_token_hook('{"claims":{"sub":"browser-user","resource":"https://lixray.com","lixray_mcp":true}}') -> 'claims',
	'{"sub":"browser-user"}'::jsonb, 'non-OAuth sessions do not retain OAuth custom permissions');

update auth.sessions set scopes = 'openid' where id = '54000000-0000-4000-8000-000000000001';
select is(private.custom_access_token_hook(pg_temp.token_event('token_refresh', '{"scope":"openid"}')) #>> '{error,http_code}', '403',
	'session scope changes cannot silently rewrite the original grant');
delete from auth.sessions where id = '54000000-0000-4000-8000-000000000001';
select is((select count(*) from private.oauth_session_resources), 0::bigint, 'session revocation deletes its durable binding');
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403', 'a deleted session cannot refresh');

insert into auth.sessions (id, user_id, oauth_client_id, scopes)
values ('54000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001',
	'53000000-0000-4000-8000-000000000001', 'openid offline_access');
update auth.oauth_authorizations set resource = '' where id = '55000000-0000-4000-8000-000000000003';
select is(private.custom_access_token_hook(pg_temp.token_event('oauth_provider/authorization_code')) #>> '{error,http_code}', '403',
	'an authorization without a resource cannot mint MCP permissions');
select is((select count(*) from private.oauth_session_resources), 0::bigint, 'invalid authorization leaves no binding');

select * from finish();
rollback;
