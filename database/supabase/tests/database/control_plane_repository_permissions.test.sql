begin;

create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (
	id, instance_id, aud, role, email, encrypted_password,
	email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
	'71000000-0000-0000-0000-000000000001',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'admin@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Repository Admin"}', now(), now()
),
(
	'71000000-0000-0000-0000-000000000002',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'member@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Repository Member"}', now(), now()
),
(
	'71000000-0000-0000-0000-000000000003',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'second-admin@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Second Admin"}', now(), now()
),
(
	'71000000-0000-0000-0000-000000000004',
	'00000000-0000-0000-0000-000000000000',
	'authenticated', 'authenticated', 'outsider@example.com', '', now(),
	'{"provider":"google","providers":["google"]}',
	'{"full_name":"Outsider"}', now(), now()
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);

select lives_ok(
	$$select * from public.bootstrap_personal_namespace()$$,
	'an admin can bootstrap a repository'
);

select results_eq(
	$$select role from public.list_lix_members(
		(select id from public.lixes where deleted_at is null limit 1)
	)
	where account_id = '71000000-0000-0000-0000-000000000001'$$,
	$$values ('admin'::public.lix_role)$$,
	'the repository creator is an admin'
);

select results_eq(
	$$select visibility from public.lixes where deleted_at is null$$,
	$$values ('private'::public.lix_visibility)$$,
	'new repositories are private'
);

select set_config(
	'test.repository_id',
	(select id::text from public.lixes where deleted_at is null limit 1),
	true
);
select set_config(
	'test.namespace_handle',
	(select namespace_handle from public.list_accessible_lixes() limit 1),
	true
);

select set_config(
	'test.member_token',
	public.get_lix_invite_link(current_setting('test.repository_id')::uuid),
	true
);
select is(
	public.get_lix_invite_link(current_setting('test.repository_id')::uuid),
	current_setting('test.member_token'),
	'the repository invite URL is stable'
);
select set_config(
	'test.rotated_member_token',
	public.reset_lix_invite_link(current_setting('test.repository_id')::uuid),
	true
);
select isnt(
	current_setting('test.rotated_member_token'),
	current_setting('test.member_token'),
	'resetting the repository invite invalidates the old URL'
);
select set_config(
	'test.member_token',
	current_setting('test.rotated_member_token'),
	true
);

select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000004","role":"authenticated"}',
	true
);

select is(
	(select count(*) from public.resolve_public_lix_by_route(
		current_setting('test.namespace_handle'), 'repository'
	)),
	0::bigint,
	'a private repository is hidden from outsiders'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000002","role":"authenticated"}',
	true
);
select lives_ok(
	$$select public.accept_lix_share_token(current_setting('test.member_token'))$$,
	'an invitation adds a normal member'
);
select results_eq(
	$$select role from public.list_lix_members(current_setting('test.repository_id')::uuid)
	where account_id = '71000000-0000-0000-0000-000000000002'$$,
	$$values ('member'::public.lix_role)$$,
	'invitations never grant admin implicitly'
);
select throws_ok(
	$$select public.set_lix_member_role(
		current_setting('test.repository_id')::uuid,
		'71000000-0000-0000-0000-000000000002',
		'admin'
	)$$,
	'P0001',
	'Repository admin access required',
	'a normal member cannot promote themselves'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000003","role":"authenticated"}',
	true
);
select lives_ok(
	$$select public.accept_lix_share_token(current_setting('test.member_token'))$$,
	'a second person can join as a member'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);
select lives_ok(
	$$select public.set_lix_member_role(
		current_setting('test.repository_id')::uuid,
		'71000000-0000-0000-0000-000000000003',
		'admin'
	)$$,
	'an admin can appoint another admin'
);
select results_eq(
	$$select account_id from public.list_lix_members(current_setting('test.repository_id')::uuid)
	where role = 'admin'
	order by account_id$$,
	$$values
		('71000000-0000-0000-0000-000000000001'::uuid),
		('71000000-0000-0000-0000-000000000003'::uuid)$$,
	'multiple repository admins are supported'
);
select lives_ok(
	$$select public.remove_lix_member(
		current_setting('test.repository_id')::uuid,
		'71000000-0000-0000-0000-000000000002'
	)$$,
	'an admin can kick a normal member'
);
select is(
	(select count(*) from public.list_lix_members(current_setting('test.repository_id')::uuid)
	where account_id = '71000000-0000-0000-0000-000000000002'),
	0::bigint,
	'the kicked member no longer has repository membership'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000003","role":"authenticated"}',
	true
);
select throws_ok(
	$$select public.remove_lix_member(
		current_setting('test.repository_id')::uuid,
		'71000000-0000-0000-0000-000000000001'
	)$$,
	'P0001',
	'Repository admins cannot leave or be removed',
	'an admin cannot remove another admin'
);
select throws_ok(
	$$select public.set_lix_member_role(
		current_setting('test.repository_id')::uuid,
		'71000000-0000-0000-0000-000000000001',
		'member'
	)$$,
	'P0001',
	'Repository admins cannot be demoted',
	'an admin cannot demote another admin'
);
select throws_ok(
	$$select public.remove_lix_member(
		current_setting('test.repository_id')::uuid,
		'71000000-0000-0000-0000-000000000003'
	)$$,
	'P0001',
	'Repository admins cannot leave or be removed',
	'an admin cannot leave'
);

select lives_ok(
	$$select public.publish_lix_resource(
		current_setting('test.repository_id')::uuid,
		'/finance/',
		'directory'
	)$$,
	'a member can publish a directory'
);
select lives_ok(
	$$select public.publish_lix_resource(
		current_setting('test.repository_id')::uuid,
		'/press/release.md',
		'file'
	)$$,
	'a member can publish a file'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select results_eq(
	$$select path_public from public.resolve_public_lix_by_route(
		current_setting('test.namespace_handle'), 'repository', '/finance/2026/q1.pdf'
	)$$,
	$$values (true)$$,
	'publishing a directory makes every descendant public'
);
select results_eq(
	$$select path_public from public.resolve_public_lix_by_route(
		current_setting('test.namespace_handle'), 'repository', '/press/release.md'
	)$$,
	$$values (true)$$,
	'publishing a file makes that exact file public'
);
select is(
	(select count(*) from public.resolve_public_lix_by_route(
		current_setting('test.namespace_handle'), 'repository', '/press/draft.md'
	)),
	0::bigint,
	'file publication does not expose a sibling'
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000003","role":"authenticated"}',
	true
);
select lives_ok(
	$$select public.set_lix_visibility(
		current_setting('test.repository_id')::uuid,
		'public'
	)$$,
	'an admin can make the whole repository public'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select results_eq(
	$$select can_edit, visibility from public.resolve_public_lix_by_route(
		current_setting('test.namespace_handle'), 'repository'
	)$$,
	$$values (false, 'public'::public.lix_visibility)$$,
	'public repositories are readable but not editable by outsiders'
);

set local role authenticated;
select set_config(
	'request.jwt.claims',
	'{"sub":"71000000-0000-0000-0000-000000000001","role":"authenticated"}',
	true
);
select results_eq(
	$$with inserted as (
		insert into public.lixes (id, namespace_id, name, slug)
		values (
			'72000000-0000-0000-0000-000000000001',
			(select namespace_id from public.lixes
			 where id = current_setting('test.repository_id')::uuid),
			'Returning repository',
			'returning-repository'
		)
		returning id
	)
	select id from inserted$$,
	$$values ('72000000-0000-0000-0000-000000000001'::uuid)$$,
	'an authenticated namespace member can create and return a repository row'
);

select * from finish();
rollback;
