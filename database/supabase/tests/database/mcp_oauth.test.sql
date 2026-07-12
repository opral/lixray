begin;

create extension if not exists pgtap with schema extensions;
select plan(15);

select is(
  private.custom_access_token_hook(
    '{"claims":{"sub":"browser-user","role":"authenticated"}}'::jsonb
  ),
  '{"claims":{"sub":"browser-user","role":"authenticated"}}'::jsonb,
  'normal browser access-token claims are unchanged'
);

select is(
  private.custom_access_token_hook(
    '{"claims":{"sub":"oauth-user","role":"authenticated","client_id":"chatgpt-client"}}'::jsonb
  ) #>> '{claims,resource}',
  'https://lixray.com',
  'OAuth access tokens receive the fixed Lixray resource claim'
);

select is(
  private.custom_access_token_hook(
    '{"claims":{"sub":"oauth-user","role":"authenticated","client_id":"chatgpt-client"}}'::jsonb
  ) #>> '{claims,lixray_mcp}',
  'true',
  'OAuth access tokens are marked as Lixray MCP sessions'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('51000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mcp-member@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"MCP Member"}', now(), now()),
  ('51000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'same-org@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Same Org"}', now(), now()),
  ('51000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Outsider"}', now(), now());

insert into public.organizations (id, name) values
  ('52000000-0000-0000-0000-000000000001', 'Visible organization'),
  ('52000000-0000-0000-0000-000000000002', 'Other organization');

insert into public.organization_members (organization_id, user_id, role) values
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'owner'),
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000002', 'member'),
  ('52000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000003', 'owner');

insert into public.workspaces (id, organization_id, name) values
  ('53000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', 'Visible workspace'),
  ('53000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000002', 'Other workspace');

insert into public.organization_invitations (
  id, organization_id, email, token_hash, invited_by, expires_at
) values (
  '54000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000001',
  'invitee@example.com',
  encode(extensions.digest('mcp-invite', 'sha256'), 'hex'),
  '51000000-0000-0000-0000-000000000001',
  now() + interval '1 day'
);

set local role authenticated;
set local request.jwt.claim.sub = '51000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{
  "sub":"51000000-0000-0000-0000-000000000001",
  "role":"authenticated",
  "aud":"authenticated",
  "client_id":"chatgpt-client",
  "resource":"https://lixray.com",
  "lixray_mcp":true
}';

select results_eq(
  'select count(*) from public.organizations',
  array[1::bigint],
  'MCP tokens only see organizations they belong to'
);

select results_eq(
  'select count(*) from public.workspaces',
  array[1::bigint],
  'MCP tokens only see workspaces in accessible organizations'
);

select results_eq(
  'select count(*) from public.profiles',
  array[0::bigint],
  'MCP tokens cannot read profiles'
);

select results_eq(
  'select count(*) from public.organization_members',
  array[0::bigint],
  'MCP tokens cannot read membership rosters'
);

select results_eq(
  'select count(*) from public.organization_invitations',
  array[0::bigint],
  'MCP tokens cannot read invitations'
);

select throws_ok(
  $$insert into public.workspaces (organization_id, name) values ('52000000-0000-0000-0000-000000000001', 'Forbidden MCP workspace')$$,
  'P0001',
  'Lixray MCP tokens cannot modify account or workspace metadata',
  'MCP tokens cannot create workspace metadata'
);

select results_eq(
  $$update public.workspaces set name = 'Forbidden rename' where id = '53000000-0000-0000-0000-000000000001' returning name$$,
  array[]::text[],
  'MCP workspace metadata updates affect no rows'
);

select throws_ok(
  $$select public.delete_workspace('53000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'Lixray MCP tokens cannot modify account or workspace metadata',
  'MCP tokens cannot soft-delete workspace metadata'
);

select throws_ok(
  $$select public.create_organization('Forbidden organization')$$,
  'P0001',
  'Lixray MCP tokens cannot modify account or workspace metadata',
  'MCP tokens cannot use organization-management RPCs'
);

set local request.jwt.claims = '{
  "sub":"51000000-0000-0000-0000-000000000001",
  "role":"authenticated",
  "aud":"authenticated"
}';

select results_eq(
  'select count(*) from public.profiles',
  array[2::bigint],
  'normal browser tokens retain shared-organization profile access'
);

select results_eq(
  'select count(*) from public.organization_members',
  array[2::bigint],
  'normal browser tokens retain membership roster access'
);

select lives_ok(
  $$insert into public.workspaces (organization_id, name) values ('52000000-0000-0000-0000-000000000001', 'Browser workspace')$$,
  'normal browser tokens retain workspace creation access'
);

select * from finish();
rollback;
