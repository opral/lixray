begin;

create extension if not exists pgtap with schema extensions;
select plan(20);

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

select results_eq(
  $$select namespace_handle, lix_name, lix_slug, created
    from public.bootstrap_personal_namespace()$$,
  $$values ('samuel'::text, 'repository'::text, 'repository'::text, true)$$,
  'first bootstrap derives the handle and creates the default repository'
);

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
      from public.resolve_public_profile_by_handle('samuel') resolved
    )
  ),
  'https://lh3.googleusercontent.com/samuel',
  'personal bootstrap seeds the public JSContact avatar from Google metadata'
);

select results_eq(
  $$select namespace_handle
    from public.resolve_public_profile_by_handle('samuel')$$,
  $$values ('samuel'::text)$$,
  'a public handle resolves to its canonical profile identity'
);

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
      from public.resolve_public_profile_by_handle('samuel') resolved
    )
  ),
  'https://lh3.googleusercontent.com/samuel',
  'later Google metadata does not overwrite the authoritative JSContact profile'
);

select is(
  (select count(*) from public.lixes where deleted_at is null),
  1::bigint,
  'bootstrap creates one default repository'
);

select results_eq(
  $$select lix_name, lix_slug, created from public.bootstrap_personal_namespace()$$,
  $$values ('repository'::text, 'repository'::text, false)$$,
  'bootstrap is idempotent and reuses the default repository'
);

select lives_ok(
  $$insert into public.lixes (id, namespace_id, name, slug)
    values (
      '20000000-0000-0000-0000-000000000001',
      (select namespace_id from public.list_accessible_lixes() limit 1),
      'Additional Repository',
      'additional-repository'
    )$$,
  'an additional repository can be explicitly created in the personal namespace'
);

select lives_ok(
  $$select public.delete_lix('20000000-0000-0000-0000-000000000001')$$,
  'an explicitly created repository can be deleted'
);

select results_eq(
  $$select lix_name, lix_slug, created from public.bootstrap_personal_namespace()$$,
  $$values ('repository'::text, 'repository'::text, false)$$,
  'bootstrap does not recreate a deleted additional repository'
);

select results_eq(
  $$select namespace_handle, lix_name, lix_slug from public.list_accessible_lixes()$$,
  $$values ('samuel'::text, 'repository'::text, 'repository'::text)$$,
  'the default repository remains visible after deleting an additional repository'
);

select lives_ok(
  $$select public.delete_lix(
    (select id from public.lixes where name = 'repository' and deleted_at is null)
  )$$,
  'the default repository can be deleted'
);

select results_eq(
  $$select lix_id, created from public.bootstrap_personal_namespace()$$,
  $$values (null::uuid, false)$$,
  'bootstrap does not recreate a deleted default repository'
);

select lives_ok(
  $$select public.create_namespace('Android')$$,
  'the same namespace model creates an organization scope'
);

select results_eq(
  $$select handle from public.handles order by handle$$,
  $$values ('android'::text), ('samuel'::text)$$,
  'personal and organization handles share one pool'
);

select * from finish();
rollback;
