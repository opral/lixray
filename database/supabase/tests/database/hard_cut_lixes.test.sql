begin;

create extension if not exists pgtap with schema extensions;
select plan(13);

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
  '{"full_name":"Samuel"}', now(), now()
);

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';

select results_eq(
  $$select namespace_handle, lix_name, lix_slug, created
    from public.bootstrap_personal_namespace()$$,
  $$values ('samuel'::text, 'Workspace'::text, 'workspace'::text, true)$$,
  'first bootstrap derives the handle and creates /@samuel/workspace'
);

select is(
  (select count(*) from public.namespaces where kind = 'personal'),
  1::bigint,
  'personal ownership uses the namespace model'
);

select is(
  (select count(*) from public.lixes where deleted_at is null),
  1::bigint,
  'bootstrap creates exactly one live lix'
);

select results_eq(
  $$select created from public.bootstrap_personal_namespace()$$,
  $$values (false)$$,
  'bootstrap is idempotent'
);

select lives_ok(
  $$select public.delete_lix((select id from public.lixes where deleted_at is null))$$,
  'the default lix can be deleted'
);

select results_eq(
  $$select lix_id, created from public.bootstrap_personal_namespace()$$,
  $$values (null::uuid, false)$$,
  'bootstrap never recreates a deleted last lix'
);

select results_eq(
  $$select namespace_handle, lix_id from public.list_accessible_lixes()$$,
  $$values ('samuel'::text, null::uuid)$$,
  'an empty namespace remains visible after deleting its last lix'
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
