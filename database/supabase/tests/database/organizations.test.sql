begin;

create extension if not exists pgtap with schema extensions;
select plan(26);

select is(
  to_regclass('public.organization_invitations')::text,
  null::text,
  'organization invitations are not part of the current schema'
);

select is(
  to_regprocedure('public.create_organization_invitation(uuid,text)')::text,
  null::text,
  'organization invitation creation is not exposed'
);

select is(
  to_regprocedure('public.revoke_organization_invitation(uuid)')::text,
  null::text,
  'organization invitation revocation is not exposed'
);

select is(
  to_regprocedure('public.accept_organization_invitation(text)')::text,
  null::text,
  'organization invitation acceptance is not exposed'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Member"}', now(), now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Outsider"}', now(), now());

insert into public.organizations (id, name) values
  ('20000000-0000-0000-0000-000000000001', 'Test organization'),
  ('20000000-0000-0000-0000-000000000002', 'Other organization');

insert into public.organization_members (organization_id, user_id, role) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 'owner');

insert into public.workspaces (id, organization_id, name) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'First workspace'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Hidden workspace');

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000002';

select is(
  public.ensure_personal_workspace(),
  true,
  'first login provisions a personal namespace and starter workspace'
);

select results_eq(
  $$select handle from public.organizations where personal_owner_id = '10000000-0000-0000-0000-000000000002'$$,
  array['member'::text],
  'the personal handle is derived from the email username'
);

select is(
  public.ensure_personal_workspace(),
  false,
  'personal workspace provisioning is idempotent'
);

select lives_ok(
  $$select public.delete_workspace(
    (select id from public.workspaces
     where organization_id = (
       select id from public.organizations
       where personal_owner_id = '10000000-0000-0000-0000-000000000002'
     ) and deleted_at is null)
  )$$,
  'the starter workspace can be soft-deleted'
);

select is(
  public.ensure_personal_workspace(),
  true,
  'provisioning recreates a starter workspace after deletion'
);

select results_eq(
  $$select count(*) from public.workspaces
    where organization_id = (
      select id from public.organizations
      where personal_owner_id = '10000000-0000-0000-0000-000000000002'
    ) and slug = 'my-workspace'$$,
  array[1::bigint],
  'the recreated workspace can reuse the deleted workspace slug'
);

select results_eq(
  'select count(*) from public.organizations',
  array[2::bigint],
  'members only see their organizations'
);

select results_eq(
  'select count(*) from public.workspaces',
  array[2::bigint],
  'members only see their organization workspaces'
);

select results_eq(
  'select handle from public.organizations where id = ''20000000-0000-0000-0000-000000000001''',
  array['test-organization'::text],
  'organizations receive a stable URL handle'
);

select results_eq(
  'select slug from public.workspaces where id = ''30000000-0000-0000-0000-000000000001''',
  array['first-workspace'::text],
  'workspaces receive a stable URL slug'
);

select lives_ok(
  $$insert into public.workspaces (organization_id, name) values ('20000000-0000-0000-0000-000000000001', 'Member workspace')$$,
  'members can create workspaces'
);

select throws_ok(
  $$insert into public.workspaces (organization_id, name) values ('20000000-0000-0000-0000-000000000002', 'Forbidden workspace')$$,
  '42501',
  'new row violates row-level security policy for table "workspaces"',
  'members cannot create workspaces in another organization'
);

select results_eq(
  $$update public.workspaces set name = 'Renamed workspace' where id = '30000000-0000-0000-0000-000000000001' returning name$$,
  array['Renamed workspace'::text],
  'members can rename their workspaces'
);

select results_eq(
  'select slug from public.workspaces where id = ''30000000-0000-0000-0000-000000000001''',
  array['first-workspace'::text],
  'renaming a workspace does not change its canonical URL slug'
);

select throws_ok(
  $$select public.rename_organization('20000000-0000-0000-0000-000000000001', 'Forbidden rename')$$,
  'P0001',
  'Organization owner access required',
  'members cannot rename organizations'
);

set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';

select lives_ok(
  $$select public.rename_organization('20000000-0000-0000-0000-000000000001', 'Renamed organization')$$,
  'owners can rename organizations'
);

select lives_ok(
  $$select public.set_organization_member_role('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'owner')$$,
  'owners can promote members'
);

select lives_ok(
  $$select public.set_organization_member_role('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member')$$,
  'an owner can be demoted when another owner remains'
);

select throws_ok(
  $$select public.set_organization_member_role('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'member')$$,
  'P0001',
  'An organization must have at least one owner',
  'the last owner cannot be demoted'
);

select throws_ok(
  $$select public.remove_organization_member('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'An organization must have at least one owner',
  'the last owner cannot be removed'
);

select lives_ok(
  $$select public.delete_workspace('30000000-0000-0000-0000-000000000001')$$,
  'members can soft-delete an accessible workspace'
);

select results_eq(
  $$select count(*) from public.workspaces where id = '30000000-0000-0000-0000-000000000001'$$,
  array[0::bigint],
  'soft-deleted workspaces disappear from member reads'
);

select * from finish();
rollback;
