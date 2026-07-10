begin;

create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Member"}', now(), now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Outsider"}', now(), now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'invited@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Invited"}', now(), now()),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wrong@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Wrong account"}', now(), now()),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'expired@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Expired invite"}', now(), now());

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

insert into public.organization_invitations (
  id, organization_id, email, token_hash, invited_by, expires_at
) values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'invited@example.com', encode(extensions.digest('valid-token', 'sha256'), 'hex'), '10000000-0000-0000-0000-000000000001', now() + interval '1 day'),
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'expired@example.com', encode(extensions.digest('expired-token', 'sha256'), 'hex'), '10000000-0000-0000-0000-000000000001', now() - interval '1 day');

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000002';

select results_eq(
  'select count(*) from public.organizations',
  array[1::bigint],
  'members only see their organizations'
);

select results_eq(
  'select count(*) from public.workspaces',
  array[1::bigint],
  'members only see their organization workspaces'
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
  $$select token from public.create_organization_invitation('20000000-0000-0000-0000-000000000001', 'new-member@example.com')$$,
  'owners can create invitations'
);

set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000005';

select throws_ok(
  $$select public.accept_organization_invitation('valid-token')$$,
  'P0001',
  'Sign in with the Google account that was invited',
  'an invitation rejects a different Google email'
);

set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000006';

select throws_ok(
  $$select public.accept_organization_invitation('expired-token')$$,
  'P0001',
  'Invitation is invalid or expired',
  'expired invitations are rejected'
);

set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000004';

select lives_ok(
  $$select public.accept_organization_invitation('valid-token')$$,
  'the invited Google account can accept an invitation'
);

select throws_ok(
  $$select public.accept_organization_invitation('valid-token')$$,
  'P0001',
  'Invitation is invalid or expired',
  'an accepted invitation cannot be reused'
);

select * from finish();
rollback;
