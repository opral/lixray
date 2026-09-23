begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

select is(to_regclass('public.organizations')::text, null::text, 'legacy organizations are gone');
select is(to_regclass('public.workspaces')::text, null::text, 'legacy workspaces are gone');
select is(to_regclass('public.namespaces')::text, 'namespaces', 'namespaces are canonical');
select is(to_regclass('public.lixes')::text, 'lixes', 'lixes are canonical');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'samuel@example.com', '', now(),
  '{"provider":"google","providers":["google"]}',
  '{"full_name":"Samuel","picture":"https://lh3.googleusercontent.com/samuel"}', now(), now()
);

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';

select ok((select created from public.bootstrap_personal_namespace()),
  'first bootstrap creates a personal namespace without a repository');
select set_config('test.personal_handle', (
  select handle.handle from public.handles handle
  join public.accounts account on account.primary_namespace_id = handle.namespace_id
  where account.id = '10000000-0000-0000-0000-000000000001' and handle.state = 'active'
), true);
select matches(current_setting('test.personal_handle'), '^[a-z]+-[a-z]+-[0-9]{6}$',
  'first bootstrap assigns a random readable username');

-- The primary-namespace pointer is not client-readable; assert as superuser,
-- scoped to the test user so pre-existing local data cannot skew the count.
reset role;
select is(
  (select count(*) from public.accounts account
   where account.id = '10000000-0000-0000-0000-000000000001'
     and account.primary_namespace_id is not null),
  1::bigint,
  'personal ownership is derived from the primary-namespace pointer'
);
set local role authenticated;

select is(
  (
    select profile.document #>> '{media,avatar,uri}'
    from public.namespace_profiles profile
    where profile.namespace_id = (
      select resolved.namespace_id
      from public.resolve_public_profile_by_handle(current_setting('test.personal_handle')) resolved
    )
  ),
  'https://lh3.googleusercontent.com/samuel',
  'personal bootstrap seeds the public JSContact avatar from Google metadata'
);

select is((select namespace_handle
  from public.resolve_public_profile_by_handle(current_setting('test.personal_handle'))),
  current_setting('test.personal_handle'),
  'a public handle resolves to its canonical profile identity');

select is(
  to_regclass('public.profiles')::text,
  null::text,
  'the redundant private presentation profile is gone'
);

reset role;
update auth.users
set raw_user_meta_data = '{"full_name":"Samuel","picture":"https://lh3.googleusercontent.com/changed"}'
where id = '10000000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';

select is(
  (
    select profile.document #>> '{media,avatar,uri}'
    from public.namespace_profiles profile
    where profile.namespace_id = (
      select resolved.namespace_id
      from public.resolve_public_profile_by_handle(current_setting('test.personal_handle')) resolved
    )
  ),
  'https://lh3.googleusercontent.com/samuel',
  'later Google metadata does not overwrite the authoritative JSContact profile'
);

select is((select count(*) from public.lixes where deleted_at is null),0::bigint,'bootstrap creates no repository');
select results_eq($$select lix_id, created from public.bootstrap_personal_namespace()$$,$$values (null::uuid,false)$$,'bootstrap is idempotent and does not initialize storage');
select lives_ok(
  $$select public.create_namespace('Android')$$,
  'the same namespace model creates an organization scope'
);

select results_eq(
  $$select handle from public.handles order by handle$$,
  $$select handle from (values ('android'::text), (current_setting('test.personal_handle'))) names(handle) order by handle$$,
  'personal and organization handles share one pool'
);

select * from finish();
rollback;
