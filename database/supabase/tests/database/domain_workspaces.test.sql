begin;

create extension if not exists pgtap with schema extensions;
select plan(36);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('71000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@gmail.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Gmail Person"}', now(), now()),
  ('71000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@yahoo.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Yahoo Person"}', now(), now()),
  ('71000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@outlook.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Outlook Person"}', now(), now()),
  ('71000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@acme.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Acme Owner"}', now(), now()),
  ('71000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member@acme.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Acme Member"}', now(), now()),
  ('71000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@acme.co.uk', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Acme UK"}', now(), now()),
  ('71000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@eu.acme.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Acme Europe"}', now(), now()),
  ('71000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@legacycorp.dev', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Legacy Person"}', now(), now()),
  ('71000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'person@collision.dev', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Collision Person"}', now(), now());

insert into public.organizations (id, name, personal_owner_id) values
  ('72000000-0000-0000-0000-000000000001', 'Legacy personal', '71000000-0000-0000-0000-000000000008');

insert into public.organization_members (organization_id, user_id, role) values
  ('72000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000008', 'owner');

insert into public.workspaces (id, organization_id, name) values
  ('73000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'Existing workspace');

insert into public.organizations (id, name) values
  ('72000000-0000-0000-0000-000000000002', 'collision');

select is(
  private.email_domain(' Person@Acme.COM '),
  'acme.com',
  'email domains are normalized before provisioning'
);

select ok(
  private.is_generic_email_domain('gmail.com'),
  'the generic email provider allowlist includes Gmail'
);

select is(
  private.domain_workspace_name('acme.co.uk'),
  'acme',
  'compound country suffixes are removed from workspace names'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000001';

select is(
  public.ensure_personal_workspace(),
  true,
  'a Gmail user receives a personal starter workspace'
);

set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000002';

select is(
  public.ensure_personal_workspace(),
  true,
  'a Yahoo user receives a personal starter workspace'
);

set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000003';

select is(
  public.ensure_personal_workspace(),
  true,
  'an Outlook user receives a personal starter workspace'
);

reset role;

select results_eq(
  $$select count(*) from public.organizations
    where personal_owner_id in (
      '71000000-0000-0000-0000-000000000001',
      '71000000-0000-0000-0000-000000000002',
      '71000000-0000-0000-0000-000000000003'
    )$$,
  array[3::bigint],
  'generic-provider users receive isolated personal organizations'
);

select results_eq(
  $$select count(*) from public.organizations organization
    join public.organization_members member on member.organization_id = organization.id
    where member.user_id in (
      '71000000-0000-0000-0000-000000000001',
      '71000000-0000-0000-0000-000000000002',
      '71000000-0000-0000-0000-000000000003'
    ) and organization.email_domain is not null$$,
  array[0::bigint],
  'generic-provider users are not assigned domain organizations'
);

select results_eq(
  $$select count(*) from public.workspaces workspace
    join public.organizations organization on organization.id = workspace.organization_id
    where organization.personal_owner_id in (
      '71000000-0000-0000-0000-000000000001',
      '71000000-0000-0000-0000-000000000002',
      '71000000-0000-0000-0000-000000000003'
    ) and workspace.name = 'My workspace' and workspace.deleted_at is null$$,
  array[3::bigint],
  'generic-provider personal workspaces retain their existing name'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000004';

select is(
  public.ensure_personal_workspace(),
  true,
  'the first corporate user creates a domain workspace'
);

select is(
  public.ensure_personal_workspace(),
  false,
  'corporate workspace provisioning is idempotent'
);

reset role;

select results_eq(
  $$select count(*) from public.organizations where email_domain = 'acme.com'$$,
  array[1::bigint],
  'a corporate email domain maps to one organization'
);

select results_eq(
  $$select name from public.workspaces
    where organization_id = (
      select id from public.organizations where email_domain = 'acme.com'
    ) and deleted_at is null$$,
  array['acme'::text],
  'the corporate workspace is named after the registered domain label'
);

select results_eq(
  $$select role::text from public.organization_members
    where organization_id = (
      select id from public.organizations where email_domain = 'acme.com'
    ) and user_id = '71000000-0000-0000-0000-000000000004'$$,
  array['owner'::text],
  'the first corporate user is the organization owner'
);

select results_eq(
  $$select count(*) from public.organizations
    where personal_owner_id = '71000000-0000-0000-0000-000000000004'$$,
  array[0::bigint],
  'a new corporate user does not also receive a personal organization'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000005';

select is(
  public.ensure_personal_workspace(),
  false,
  'a later corporate user joins without creating another workspace'
);

reset role;

select results_eq(
  $$select count(*) from public.organizations where email_domain = 'acme.com'$$,
  array[1::bigint],
  'a later corporate user does not duplicate the organization'
);

select results_eq(
  $$select count(*) from public.organization_members
    where organization_id = (
      select id from public.organizations where email_domain = 'acme.com'
    )$$,
  array[2::bigint],
  'users with the same exact domain share the organization'
);

select results_eq(
  $$select role::text from public.organization_members
    where organization_id = (
      select id from public.organizations where email_domain = 'acme.com'
    ) and user_id = '71000000-0000-0000-0000-000000000005'$$,
  array['member'::text],
  'later corporate users join as members'
);

select results_eq(
  $$select count(*) from public.workspaces
    where organization_id = (
      select id from public.organizations where email_domain = 'acme.com'
    ) and deleted_at is null$$,
  array[1::bigint],
  'same-domain provisioning keeps a single starter workspace'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000006';

select is(
  public.ensure_personal_workspace(),
  true,
  'a corporate address under co.uk creates a workspace'
);

reset role;

select results_eq(
  $$select organization.name || '|' || workspace.name
    from public.organizations organization
    join public.workspaces workspace on workspace.organization_id = organization.id
    where organization.email_domain = 'acme.co.uk' and workspace.deleted_at is null$$,
  array['acme|acme'::text],
  'co.uk organizations and workspaces use the registered label'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000007';

select is(
  public.ensure_personal_workspace(),
  true,
  'a corporate subdomain creates its own workspace'
);

reset role;

select results_eq(
  $$select count(*) from public.organizations
    where email_domain in ('acme.com', 'eu.acme.com')$$,
  array[2::bigint],
  'exact email domains remain separate access groups'
);

select results_eq(
  $$select count(*) from public.organizations
    where email_domain in ('acme.com', 'eu.acme.com') and name = 'acme'$$,
  array[2::bigint],
  'separate subdomain organizations can share the registered-label name'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000008';

select is(
  public.ensure_personal_workspace(),
  true,
  'an existing corporate user gains a domain workspace'
);

reset role;

select results_eq(
  $$select count(*) from public.organization_members
    where user_id = '71000000-0000-0000-0000-000000000008'$$,
  array[2::bigint],
  'an existing corporate user keeps personal and domain memberships'
);

select results_eq(
  $$select workspace.name from public.workspaces workspace
    join public.organizations organization on organization.id = workspace.organization_id
    where organization.personal_owner_id = '71000000-0000-0000-0000-000000000008'
      and workspace.deleted_at is null$$,
  array['Existing workspace'::text],
  'existing personal workspace data is preserved'
);

select results_eq(
  $$select workspace.name from public.workspaces workspace
    join public.organizations organization on organization.id = workspace.organization_id
    where organization.email_domain = 'legacycorp.dev' and workspace.deleted_at is null$$,
  array['legacycorp'::text],
  'the existing user also receives the domain workspace'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000009';

select is(
  public.ensure_personal_workspace(),
  true,
  'a manual organization-name collision does not block domain provisioning'
);

reset role;

select results_eq(
  $$select count(*) from public.organizations where name = 'collision'$$,
  array[2::bigint],
  'manual and domain organizations with the same name remain distinct'
);

select results_eq(
  $$select count(*) from public.organizations
    where name = 'collision' and email_domain = 'collision.dev'$$,
  array[1::bigint],
  'only the domain-tagged organization receives automatic members'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000005';

select lives_ok(
  $$select public.leave_organization(
    (select id from public.organizations where email_domain = 'acme.com')
  )$$,
  'a same-domain member can leave the organization'
);

reset role;

select results_eq(
  $$select count(*) from public.organization_members
    where user_id = '71000000-0000-0000-0000-000000000005'
      and organization_id = (
        select id from public.organizations where email_domain = 'acme.com'
      )$$,
  array[0::bigint],
  'leaving removes the automatic membership immediately'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-0000-0000-000000000005';

select is(
  public.ensure_personal_workspace(),
  false,
  'the next provisioning pass restores eligible domain membership'
);

reset role;

select results_eq(
  $$select role::text from public.organization_members
    where user_id = '71000000-0000-0000-0000-000000000005'
      and organization_id = (
        select id from public.organizations where email_domain = 'acme.com'
      )$$,
  array['member'::text],
  'restored domain membership uses the member role'
);

select * from finish();
rollback;
