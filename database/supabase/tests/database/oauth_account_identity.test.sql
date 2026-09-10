begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values ('85000000-0000-4000-8000-000000000001', 'oauth-account@example.com', '{}', '{}');
insert into public.accounts (id) values ('85000000-0000-4000-8000-000000000002');
update public.account_logins set account_id = '85000000-0000-4000-8000-000000000002'
where auth_user_id = '85000000-0000-4000-8000-000000000001';
insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_type, token_endpoint_auth_method)
values ('85000000-0000-4000-8000-000000000003', 'dynamic', 'http://127.0.0.1/callback', 'authorization_code,refresh_token', 'public', 'none');
insert into auth.sessions (id, user_id, oauth_client_id, scopes)
values ('85000000-0000-4000-8000-000000000004', '85000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000003', 'openid offline_access');
insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, resource, status)
values ('85000000-0000-4000-8000-000000000005', 'account-identity', '85000000-0000-4000-8000-000000000003', '85000000-0000-4000-8000-000000000001', 'http://127.0.0.1/callback', 'openid offline_access', 'https://lixray.com/mcp', 'approved');
update auth.sessions set created_at = clock_timestamp() where id = '85000000-0000-4000-8000-000000000004';

create function pg_temp.account_token_event(method text default 'token_refresh', patch jsonb default '{}')
returns jsonb language sql as $$
select jsonb_build_object('user_id', '85000000-0000-4000-8000-000000000001', 'authentication_method', method,
    'claims', jsonb_build_object('sub', '85000000-0000-4000-8000-000000000001', 'client_id', '85000000-0000-4000-8000-000000000003',
        'session_id', '85000000-0000-4000-8000-000000000004', 'scope', 'openid offline_access', 'account_id', 'forged-account') || patch);
$$;

-- A hook runs as Auth without an application request JWT. Account resolution
-- must use the event's trusted user rather than current_account_id().
set local request.jwt.claims = '{}';
select is(private.custom_access_token_hook(pg_temp.account_token_event('oauth_provider/authorization_code')) #>> '{claims,account_id}', '85000000-0000-4000-8000-000000000002', 'code exchange replaces forged account claim with canonical login mapping');
delete from auth.oauth_authorizations where id = '85000000-0000-4000-8000-000000000005';
select is(private.custom_access_token_hook(pg_temp.account_token_event()) #>> '{claims,account_id}', '85000000-0000-4000-8000-000000000002', 'refresh retains canonical account after transaction record deletion');
select is(private.custom_access_token_hook(pg_temp.account_token_event()) #>> '{claims,resource}', 'https://lixray.com', 'canonical account mapping does not interfere with durable resource');
select is(private.custom_access_token_hook(pg_temp.account_token_event('password', '{"client_id":null}')) #>> '{claims,account_id}', '85000000-0000-4000-8000-000000000002', 'interactive issuance also resolves canonical account without a request JWT');
update public.accounts set status = 'suspended' where id = '85000000-0000-4000-8000-000000000002';
select is(private.custom_access_token_hook(pg_temp.account_token_event()) #>> '{claims,account_id}', null::text, 'suspended account cannot retain an injected account claim');
select * from finish();
rollback;
