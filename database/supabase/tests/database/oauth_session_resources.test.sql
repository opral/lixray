begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into private.oauth_resource_policy values ('http://127.0.0.1:8787') on conflict do nothing;

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values ('52000000-0000-4000-8000-000000000001', 'resource-test@example.com', '{}', '{}');
insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_type, token_endpoint_auth_method)
values ('53000000-0000-4000-8000-000000000001', 'dynamic', 'http://127.0.0.1/callback', 'authorization_code,refresh_token', 'public', 'none');
insert into auth.sessions (id, user_id, oauth_client_id, scopes, created_at)
values ('54000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001',
 '53000000-0000-4000-8000-000000000001', 'openid offline_access', clock_timestamp());
create function pg_temp.token_event(patch jsonb default '{}') returns jsonb language sql as $$
 select jsonb_build_object('user_id','52000000-0000-4000-8000-000000000001',
 'authentication_method','oauth_provider/authorization_code', 'claims', jsonb_build_object(
 'sub','52000000-0000-4000-8000-000000000001', 'client_id','53000000-0000-4000-8000-000000000001',
 'session_id','54000000-0000-4000-8000-000000000001', 'scope','openid offline_access') || patch);
$$;

select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403', 'registration alone does not approve a resource');
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status)
values ('55000000-0000-4000-8000-000000000001', 'resource-test', '53000000-0000-4000-8000-000000000001',
 '52000000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid offline_access','https://lixray.com/mcp','pending');
select is((select count(*) from private.oauth_client_resources where client_id='53000000-0000-4000-8000-000000000001'), 0::bigint, 'pending consent grants no mapping');
update auth.oauth_authorizations set status='approved' where authorization_id='resource-test';
select is((select resource from private.oauth_client_resources where client_id='53000000-0000-4000-8000-000000000001'), 'https://lixray.com', 'approval binds the exact client to a canonical resource');
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403', 'a session created before approval cannot inherit the mapping');

-- Previously proven sessions survive the migration, but an unbound old session
-- cannot borrow permission from a later approval for the same client.
insert into private.oauth_session_resources(session_id,user_id,client_id,authorization_id,resource,scopes)
values ('54000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
 '53000000-0000-4000-8000-000000000001','55000000-0000-4000-8000-000000000001','https://lixray.com','openid offline_access');
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{claims,resource}', 'https://lixray.com', 'proven legacy binding bridges approval cutoff');
update private.oauth_session_resources set resource='https://foreign.example';
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403', 'foreign legacy resource cannot bridge cutoff');
delete from private.oauth_session_resources where session_id='54000000-0000-4000-8000-000000000001';
update auth.sessions set created_at=clock_timestamp() where id='54000000-0000-4000-8000-000000000001';
select is(private.custom_access_token_hook(pg_temp.token_event('{"resource":"https://attacker.example"}')) #>> '{claims,resource}', 'https://lixray.com', 'new issuance uses approved mapping, ignoring incoming claims');
select is(private.custom_access_token_hook(pg_temp.token_event('{"scope":"openid"}')) #>> '{error,http_code}', '403', 'claims cannot change session scopes');
select is(private.custom_access_token_hook(pg_temp.token_event('{"sub":"52000000-0000-4000-8000-000000000002"}')) #>> '{error,http_code}', '403', 'claims cannot change session user');
select is(private.custom_access_token_hook(pg_temp.token_event('{"client_id":"53000000-0000-4000-8000-000000000002"}')) #>> '{error,http_code}', '403', 'claims cannot change session client');
select throws_ok($$update auth.oauth_authorizations set resource='https://attacker.example' where authorization_id='resource-test'$$, '22023', 'Unsupported LixRay OAuth resource.', 'unsupported approved resource rejected in the database');
select throws_ok($$update auth.oauth_authorizations set resource='http://127.0.0.1:8787/mcp' where authorization_id='resource-test'$$, '22023', 'OAuth client is already bound to another resource.', 'client mapping cannot change');
delete from private.oauth_resource_policy where resource='http://127.0.0.1:8787';
select throws_ok($$update auth.oauth_authorizations set resource='http://127.0.0.1:8787/mcp' where authorization_id='resource-test'$$, '22023', 'Unsupported LixRay OAuth resource.', 'production policy rejects local targets before client binding');
insert into private.oauth_resource_policy values ('http://127.0.0.1:8787');
select throws_ok($$update auth.oauth_authorizations set resource=null where authorization_id='resource-test'$$, '22023', 'Unsupported LixRay OAuth resource.', 'missing resource rejected');
select throws_ok($$update auth.oauth_authorizations set resource='https://lixray.com.evil/mcp' where authorization_id='resource-test'$$, '22023', 'Unsupported LixRay OAuth resource.', 'lookalike host rejected');
select throws_ok($$update auth.oauth_authorizations set resource='https://lixray.com/other' where authorization_id='resource-test'$$, '22023', 'Unsupported LixRay OAuth resource.', 'unsupported path rejected');

insert into auth.oauth_authorizations(id,authorization_id,client_id,user_id,redirect_uri,scope,resource,status,created_at,expires_at)
values ('55000000-0000-4000-8000-000000000002','abandoned','53000000-0000-4000-8000-000000000001',
 '52000000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid','https://lixray.com/mcp/','approved',now()-interval '1 hour',now()-interval '30 minutes');
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{claims,resource}', 'https://lixray.com', 'expired overlapping approval does not block issuance');
delete from auth.oauth_authorizations where client_id='53000000-0000-4000-8000-000000000001';
select is(private.custom_access_token_hook(jsonb_set(pg_temp.token_event(),'{authentication_method}','"token_refresh"')) #>> '{claims,resource}', 'https://lixray.com', 'refresh needs no authorization rows');
select is((select count(*) from private.oauth_session_resources where client_id='53000000-0000-4000-8000-000000000001'),0::bigint,'new issuance creates no session resource records');
select ok(not has_table_privilege('anon','private.oauth_client_resources','SELECT'),'anonymous cannot read mappings');
select ok(not has_table_privilege('authenticated','private.oauth_client_resources','SELECT,INSERT,UPDATE,DELETE'),'users cannot read or forge mappings');
select ok(not has_table_privilege('service_role','private.oauth_client_resources','SELECT,INSERT,UPDATE,DELETE'),'service API cannot forge mappings');
select ok(not has_table_privilege('supabase_auth_admin','private.oauth_client_resources','INSERT,UPDATE,DELETE'),'Auth writes only through approval trigger');
select ok(not has_function_privilege('authenticated','private.custom_access_token_hook(jsonb)','EXECUTE'),'users cannot invoke hook');
select ok(not has_function_privilege('authenticated','private.bind_oauth_client_resource()','EXECUTE'),'users cannot invoke approval trigger');
select is(private.custom_access_token_hook('{"claims":{"sub":"browser-user","resource":"https://lixray.com","lixray_mcp":true}}')->'claims','{"sub":"browser-user"}'::jsonb,'browser tokens retain no MCP permissions');

select ok(not has_table_privilege('authenticated','private.oauth_resource_policy','INSERT,UPDATE,DELETE'),'users cannot enable resource targets');
select ok(not has_table_privilege('supabase_auth_admin','private.oauth_resource_policy','INSERT,UPDATE,DELETE'),'Auth cannot enable resource targets');

-- Only the local issuer may issue tokens for local development resources.
update private.oauth_client_resources set resource='http://127.0.0.1:8787' where client_id='53000000-0000-4000-8000-000000000001';
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403', 'missing issuer cannot issue local tokens');
select is(private.custom_access_token_hook(pg_temp.token_event('{"iss":"https://example.supabase.co/auth/v1"}')) #>> '{error,http_code}', '403', 'hosted issuer cannot issue local tokens');
select is(private.custom_access_token_hook(pg_temp.token_event('{"iss":"http://127.0.0.1:54321/auth/v1"}')) #>> '{claims,resource}', 'http://127.0.0.1:8787', 'local issuer can issue local tokens');
delete from auth.sessions where id='54000000-0000-4000-8000-000000000001';
select is(private.custom_access_token_hook(pg_temp.token_event()) #>> '{error,http_code}', '403', 'deleted session cannot issue tokens');
delete from auth.oauth_clients where id='53000000-0000-4000-8000-000000000001';
select is((select count(*) from private.oauth_client_resources where client_id='53000000-0000-4000-8000-000000000001'),0::bigint,'client deletion removes mapping');
select * from finish();
rollback;
