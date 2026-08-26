begin;

create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (
	id, instance_id, aud, role, email, encrypted_password,
	email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
	'60000000-0000-0000-0000-000000000001',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'new-user@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"New User"}', now(), now()
), (
	'60000000-0000-0000-0000-000000000002',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'returning@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Returning User"}', now(), now()
), (
	'60000000-0000-0000-0000-000000000003',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'mcp-first@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"MCP First"}', now(), now()
);

insert into private.lixray_signup_captures (user_id)
values ('60000000-0000-0000-0000-000000000002');

select throws_ok(
	$$select * from public.claim_lixray_user_signup()$$,
	'P0001',
	'Authentication required',
	'an anonymous session cannot claim a signup'
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);

select results_eq(
	$$select claimed, email, name from public.claim_lixray_user_signup()$$,
	$$values (true, 'new-user@example.com'::text, 'New User'::text)$$,
	'the first interactive claim emits once with identity email and name'
);

select results_eq(
	$$select claimed, email, name from public.claim_lixray_user_signup()$$,
	$$values (false, 'new-user@example.com'::text, 'New User'::text)$$,
	'a returning interactive login does not claim again'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated","client_id":"codex-local","resource":"https://lixray.com","lixray_mcp":true}',
	true
);

select results_eq(
	$$select claimed from public.claim_lixray_user_signup()$$,
	$$values (false)$$,
	'an MCP session cannot recapture a web-created account'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"60000000-0000-0000-0000-000000000003","role":"authenticated","client_id":"codex-local","resource":"https://lixray.com","lixray_mcp":true}',
	true
);

select results_eq(
	$$select claimed, email, name from public.claim_lixray_user_signup()$$,
	$$values (true, 'mcp-first@example.com'::text, 'MCP First'::text)$$,
	'an MCP-first account can claim signup without an interactive session'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"60000000-0000-0000-0000-000000000002","role":"authenticated"}',
	true
);

select results_eq(
	$$select claimed from public.claim_lixray_user_signup()$$,
	$$values (false)$$,
	'profiles already captured at migrate or login do not emit again'
);

select throws_ok(
	$$select * from private.lixray_signup_captures$$,
	'42501',
	'permission denied for table lixray_signup_captures',
	'direct reads of the capture table are not granted to authenticated clients'
);

reset role;

select is(
	(select count(*) from private.lixray_signup_captures
		where user_id in (
			'60000000-0000-0000-0000-000000000001',
			'60000000-0000-0000-0000-000000000003'
		)),
	2::bigint,
	'each new account stores exactly one capture row'
);

select is(
	(select email from public.profiles
		where id = '60000000-0000-0000-0000-000000000001'),
	'new-user@example.com',
	'the capture reads the synced auth identity, not a client guess'
);

select * from finish();
rollback;
