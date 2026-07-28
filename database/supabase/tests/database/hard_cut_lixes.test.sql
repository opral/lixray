begin;

create extension if not exists pgtap with schema extensions;
select plan(14);

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
  $$select namespace_handle, lix_id, lix_name, lix_slug, created
    from public.bootstrap_personal_namespace()$$,
  $$values ('samuel'::text, null::uuid, null::text, null::text, true)$$,
  'first bootstrap derives the handle without creating a workspace'
);

select is(
  (select count(*) from public.namespaces where kind = 'personal'),
  1::bigint,
  'personal ownership uses the namespace model'
);

select is(
  (select count(*) from public.lixes where deleted_at is null),
  0::bigint,
  'bootstrap leaves the workspace directory empty'
);

select results_eq(
  $$select created from public.bootstrap_personal_namespace()$$,
  $$values (false)$$,
  'bootstrap is idempotent'
);

select lives_ok(
  $$insert into public.lixes (id, namespace_id, name, slug)
    values (
      '20000000-0000-0000-0000-000000000001',
      (select namespace_id from public.list_accessible_lixes() limit 1),
      'Workspace',
      'workspace'
    )$$,
  'a workspace can be explicitly created in the personal namespace'
);

select lives_ok(
  $$select public.delete_lix('20000000-0000-0000-0000-000000000001')$$,
  'an explicitly created workspace can be deleted'
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
