begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users (id,email,raw_app_meta_data,raw_user_meta_data) values
 ('86100000-0000-4000-8000-000000000001','hygiene-one@example.com','{}','{}'),
 ('86100000-0000-4000-8000-000000000002','hygiene-two@example.com','{}','{}');
insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_name, client_type, token_endpoint_auth_method) values
 ('86100000-0000-4000-8000-000000000021','dynamic','http://127.0.0.1/callback','authorization_code refresh_token','Cursor','public','none'),
 ('86100000-0000-4000-8000-000000000022','dynamic','http://127.0.0.1/callback','authorization_code refresh_token','Codex','public','none');

-- A fresh approval sweeps the client's expired, never exchanged authorizations.
-- expires_at must follow created_at, so stale rows are created in the past.
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status, created_at, expires_at) values
 ('86100000-0000-4000-8000-000000000031','stale-approved','86100000-0000-4000-8000-000000000021','86100000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid','https://lixray.com','approved',clock_timestamp() - interval '2 hours',clock_timestamp() - interval '1 hour');
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status, created_at, expires_at) values
 ('86100000-0000-4000-8000-000000000032','stale-pending','86100000-0000-4000-8000-000000000021','86100000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid','https://lixray.com','pending',clock_timestamp() - interval '2 hours',clock_timestamp() - interval '1 hour'),
 ('86100000-0000-4000-8000-000000000034','other-client-stale','86100000-0000-4000-8000-000000000022','86100000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid','https://lixray.com','pending',clock_timestamp() - interval '2 hours',clock_timestamp() - interval '1 hour'),
 ('86100000-0000-4000-8000-000000000035','fresh','86100000-0000-4000-8000-000000000021','86100000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid','https://lixray.com','pending',clock_timestamp(),clock_timestamp() + interval '10 minutes');
select is((select count(*) from auth.oauth_authorizations where client_id='86100000-0000-4000-8000-000000000021'),3::bigint,'a pending authorization sweeps nothing');
update auth.oauth_authorizations set status='approved' where authorization_id='fresh';
select is((select array_agg(authorization_id order by authorization_id) from auth.oauth_authorizations where client_id='86100000-0000-4000-8000-000000000021'),array['fresh'],'approval sweeps the client''s expired pending and approved authorizations');
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status, created_at, expires_at) values
 ('86100000-0000-4000-8000-000000000033','live-approved','86100000-0000-4000-8000-000000000021','86100000-0000-4000-8000-000000000001','http://127.0.0.1/callback','openid','https://lixray.com','pending',clock_timestamp(),clock_timestamp() + interval '1 hour');
update auth.oauth_authorizations set status='approved' where authorization_id='live-approved';
select is((select array_agg(authorization_id order by authorization_id) from auth.oauth_authorizations where client_id='86100000-0000-4000-8000-000000000021'),array['fresh','live-approved'],'unexpired approvals survive a later approval');
select is((select count(*) from auth.oauth_authorizations where authorization_id='other-client-stale'),1::bigint,'another client''s authorizations are untouched');

-- Connected apps: what LixRay recorded about each client, and forgetting it.
set local role authenticated;
set local request.jwt.claims = '{"sub":"86100000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap first account');
set local request.jwt.claims = '{"sub":"86100000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap second account');
reset role;
insert into public.lixes(id,namespace_id,name,slug)
select '86100000-0000-4000-8000-000000000011',primary_namespace_id,'Hygiene one','hygiene-one' from public.accounts where id='86100000-0000-4000-8000-000000000001';
insert into public.lixes(id,namespace_id,name,slug)
select '86100000-0000-4000-8000-000000000012',primary_namespace_id,'Hygiene two','hygiene-two' from public.accounts where id='86100000-0000-4000-8000-000000000001';
insert into public.lixes(id,namespace_id,name,slug)
select '86100000-0000-4000-8000-000000000013',primary_namespace_id,'Hygiene other','hygiene-other' from public.accounts where id='86100000-0000-4000-8000-000000000002';
insert into public.mcp_lix_connections(account_id,lix_id,oauth_client_id,last_tool,connected_at,last_seen_at) values
 ('86100000-0000-4000-8000-000000000001','86100000-0000-4000-8000-000000000011','86100000-0000-4000-8000-000000000021','query_sql','2026-09-01T00:00:00Z','2026-09-10T00:00:00Z'),
 ('86100000-0000-4000-8000-000000000001','86100000-0000-4000-8000-000000000012','86100000-0000-4000-8000-000000000021','execute_sql','2026-09-02T00:00:00Z','2026-09-11T00:00:00Z'),
 ('86100000-0000-4000-8000-000000000001','86100000-0000-4000-8000-000000000011','86100000-0000-4000-8000-000000000022','open_lix','2026-09-03T00:00:00Z','2026-09-04T00:00:00Z'),
 ('86100000-0000-4000-8000-000000000002','86100000-0000-4000-8000-000000000013','86100000-0000-4000-8000-000000000021','open_lix','2026-09-05T00:00:00Z','2026-09-06T00:00:00Z');
set local role authenticated;
set local request.jwt.claims = '{"sub":"86100000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(
 'select oauth_client_id, repository_count, last_tool, last_seen_at, connected_at from public.list_mcp_client_connections()',
 $$values ('86100000-0000-4000-8000-000000000021',2::bigint,'execute_sql','2026-09-11T00:00:00Z'::timestamptz,'2026-09-01T00:00:00Z'::timestamptz),
         ('86100000-0000-4000-8000-000000000022',1::bigint,'open_lix','2026-09-04T00:00:00Z'::timestamptz,'2026-09-03T00:00:00Z'::timestamptz)$$,
 'connected apps list one row per client with the latest tool and use');
select lives_ok($$select public.forget_mcp_client('86100000-0000-4000-8000-000000000021')$$,'forget a client');
select is((select count(*) from public.list_mcp_client_connections()),1::bigint,'the forgotten client leaves the list');
reset role;
select is((select count(*) from public.mcp_lix_connections where oauth_client_id='86100000-0000-4000-8000-000000000021'),1::bigint,'another account''s record of the same client stays');
set local role anon;
select throws_ok($$select public.list_mcp_client_connections()$$,'42501',null,'anonymous callers cannot list connections');
select * from finish();
rollback;
