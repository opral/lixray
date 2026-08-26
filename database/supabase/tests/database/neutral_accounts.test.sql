begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (
	id, instance_id, aud, role, email, encrypted_password,
	email_confirmed_at, created_at, updated_at, raw_app_meta_data,
	raw_user_meta_data
) values
(
	'82000000-0000-0000-0000-000000000001',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'person-private@example.com', '',
	now(), now(), now(), '{}', '{"full_name":"Example Person"}'
),
(
	'82000000-0000-0000-0000-000000000002',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'person-work@example.com', '',
	now(), now(), now(), '{}', '{"full_name":"Example Work Login"}'
),
(
	'82000000-0000-0000-0000-000000000003',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'unmapped@example.com', '',
	now(), now(), now(), '{}', '{}'
);

select is(
	(select count(*) from public.accounts where id in (
		'82000000-0000-0000-0000-000000000001',
		'82000000-0000-0000-0000-000000000002',
		'82000000-0000-0000-0000-000000000003'
	)), 3::bigint,
	'auth trigger eagerly creates neutral accounts'
);

select is(
	(select count(*) from public.account_logins where auth_user_id in (
		'82000000-0000-0000-0000-000000000001',
		'82000000-0000-0000-0000-000000000002',
		'82000000-0000-0000-0000-000000000003'
	)), 3::bigint,
	'auth trigger eagerly maps login methods'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"82000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(private.current_account_id(),
	'82000000-0000-0000-0000-000000000001'::uuid,
	'login resolves to its active account');

select ok((select created from public.bootstrap_personal_namespace()),
	'personal namespace bootstrap succeeds');
select is(
	(select profile_uri from public.current_account()),
	(select 'https://lixray.com/profile/' || account.primary_namespace_id::text
	 from public.accounts account
	 where account.id = '82000000-0000-0000-0000-000000000001'),
	'canonical account exposes a derived non-empty profile URI'
);

select throws_ok(
	$$select public.remove_namespace_member(
		(select primary_namespace_id from public.accounts
		 where id = '82000000-0000-0000-0000-000000000001'),
		'82000000-0000-0000-0000-000000000001'
	)$$,
	'P0001',
	'Personal namespaces cannot be left or have members removed',
	'a personal namespace cannot be left through the organization RPC'
);
reset role;
select is(
	(select count(*) from public.lix_members repository_member
	 join public.lixes repository on repository.id = repository_member.lix_id
	 join public.accounts account on account.primary_namespace_id = repository.namespace_id
	 where account.id = '82000000-0000-0000-0000-000000000001'
		and repository_member.account_id = account.id),
	1::bigint,
	'rejected personal namespace removal preserves repository access'
);

update public.account_logins
set account_id = '82000000-0000-0000-0000-000000000001'
where auth_user_id = '82000000-0000-0000-0000-000000000002';

set local role authenticated;
set local request.jwt.claims = '{"sub":"82000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(private.current_account_id(),
	'82000000-0000-0000-0000-000000000001'::uuid,
	'second login resolves to the same canonical account');
select is((select account_id from public.current_account()),
	'82000000-0000-0000-0000-000000000001'::uuid,
	'both login methods expose the same profile account');

reset role;
select is(
	private.custom_access_token_hook(jsonb_build_object(
		'user_id', '82000000-0000-0000-0000-000000000002',
		'claims', jsonb_build_object('sub', '82000000-0000-0000-0000-000000000002')
	)) #>> '{claims,account_id}',
	'82000000-0000-0000-0000-000000000001',
	'access token hook emits canonical account_id'
);

update public.accounts set status = 'suspended'
where id = '82000000-0000-0000-0000-000000000001';
select is(
	private.custom_access_token_hook(jsonb_build_object(
		'user_id', '82000000-0000-0000-0000-000000000002',
		'claims', jsonb_build_object(
			'sub', '82000000-0000-0000-0000-000000000002',
			'account_id', '82000000-0000-0000-0000-000000000099'
		)
	)) #>> '{claims,account_id}',
	null::text,
	'token hook removes a stale account_id for a suspended account'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"82000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(private.current_account_id(), null::uuid,
	'suspended account fails closed');
select is((select count(*) from public.current_account()), 0::bigint,
	'suspended account exposes no canonical identity');

reset role;
delete from public.account_logins
where auth_user_id = '82000000-0000-0000-0000-000000000003';
set local role authenticated;
set local request.jwt.claims = '{"sub":"82000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(private.current_account_id(), null::uuid,
	'unmapped login fails closed');

select * from finish();
rollback;
