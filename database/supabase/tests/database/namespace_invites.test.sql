begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (
	id, instance_id, aud, role, email, encrypted_password,
	email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
	'50000000-0000-0000-0000-000000000001',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'invite-owner@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Invite Owner"}', now(), now()
),
(
	'50000000-0000-0000-0000-000000000002',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'invitee@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Invitee"}', now(), now()
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"50000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);

select lives_ok(
	$$select * from public.bootstrap_personal_namespace()$$,
	'the inviter creates a namespace'
);

select lives_ok(
	$$insert into public.lixes (id, namespace_id, name, slug)
	values (
		'60000000-0000-0000-0000-000000000001',
		(select namespace_id from public.list_accessible_lixes() limit 1),
		'Invited Repository',
		'invited-repository'
	)$$,
	'the inviter creates the repository'
);

select set_config(
	'test.namespace_invite_token',
	public.get_namespace_invite_link(
		(select namespace_id from public.list_accessible_lixes() limit 1)
	),
	true
);

select set_config(
	'request.jwt.claims',
	'{"sub":"50000000-0000-0000-0000-000000000002","role":"authenticated"}',
	true
);

select is(
	(select count(*) from public.resolve_public_lix_by_route(
		'invite-owner', 'invited-repository'
	)),
	0::bigint,
	'the invitee cannot discover the private repository before joining'
);

select lives_ok(
	$$select * from public.accept_namespace_invite(
		current_setting('test.namespace_invite_token')
	)$$,
	'the invitee accepts the namespace invite'
);

select results_eq(
	$$select role from public.namespace_members
	where user_id = '50000000-0000-0000-0000-000000000002'$$,
	$$values ('member'::public.namespace_role)$$,
	'the invite creates namespace membership'
);

select results_eq(
	$$select can_edit from public.resolve_public_lix_by_route(
		'invite-owner', 'invited-repository'
	)$$,
	$$values (true)$$,
	'the accepted invite resolves to edit access'
);

select is(
	(select count(*) from public.lixes
		where id = '60000000-0000-0000-0000-000000000001'),
	1::bigint,
	'the joined member can read the repository through RLS'
);

select * from finish();
rollback;
