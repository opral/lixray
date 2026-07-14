begin;

create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('61000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'personal-a@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Personal A"}', now(), now()),
  ('61000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'personal-b@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Personal B"}', now(), now());

insert into public.organizations (id, name) values
  ('62000000-0000-0000-0000-000000000001', 'Personal state organization');

insert into public.organization_members (organization_id, user_id, role) values
  ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 'owner'),
  ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000002', 'member');

insert into public.workspaces (id, organization_id, name) values
  ('63000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Personal state workspace');

set local role authenticated;
set local request.jwt.claim.sub = '61000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{
  "sub":"61000000-0000-0000-0000-000000000001",
  "role":"authenticated",
  "aud":"authenticated"
}';

select lives_ok(
  $$insert into public.user_workspace_preferences (
      user_id, workspace_id, atelier_layout
    ) values (
      '61000000-0000-0000-0000-000000000001',
      '63000000-0000-0000-0000-000000000001',
      '{"version":1,"layout":{"sizes":{"left":20,"central":80,"right":0}}}'
    )$$,
  'an interactive member can save private layout preferences'
);

select lives_ok(
  $$insert into public.user_workspace_review_resolutions (
      user_id, workspace_id, branch_id, review_id, file_id, outcome
    ) values (
      '61000000-0000-0000-0000-000000000001',
      '63000000-0000-0000-0000-000000000001',
      'main', 'review-1', 'file-1', 'accepted'
    )$$,
  'an interactive member can save a private review outcome'
);

select results_eq(
  'select count(*) from public.user_workspace_preferences',
  array[1::bigint],
  'a member can read their own layout preference'
);

select results_eq(
  'select count(*) from public.user_workspace_review_resolutions',
  array[1::bigint],
  'a member can read their own review outcomes'
);

set local request.jwt.claim.sub = '61000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{
  "sub":"61000000-0000-0000-0000-000000000002",
  "role":"authenticated",
  "aud":"authenticated"
}';

select results_eq(
  'select count(*) from public.user_workspace_preferences',
  array[0::bigint],
  'another workspace member cannot read account A preferences'
);

select results_eq(
  'select count(*) from public.user_workspace_review_resolutions',
  array[0::bigint],
  'another workspace member cannot read account A review outcomes'
);

select results_eq(
  $$update public.user_workspace_preferences
      set atelier_layout = '{"version":1,"layout":{"sizes":{"left":0,"central":100,"right":0}}}'
      where user_id = '61000000-0000-0000-0000-000000000001'
      returning user_id$$,
  array[]::uuid[],
  'another workspace member cannot overwrite account A preferences'
);

select throws_ok(
  $$insert into public.user_workspace_preferences (
      user_id, workspace_id, atelier_layout
    ) values (
      '61000000-0000-0000-0000-000000000001',
      '63000000-0000-0000-0000-000000000001',
      '{"version":1,"layout":{"sizes":{"left":0,"central":100,"right":0}}}'
    )$$,
  '42501',
  'new row violates row-level security policy for table "user_workspace_preferences"',
  'another workspace member cannot insert preferences for account A'
);

select lives_ok(
  $$insert into public.user_workspace_preferences (
      user_id, workspace_id, atelier_layout
    ) values (
      '61000000-0000-0000-0000-000000000002',
      '63000000-0000-0000-0000-000000000001',
      '{"version":1,"layout":{"sizes":{"left":0,"central":100,"right":0}}}'
    )$$,
  'account B can save an independent preference for the same workspace'
);

select results_eq(
  'select count(*) from public.user_workspace_preferences',
  array[1::bigint],
  'account B sees only its own preference'
);

select throws_ok(
  $$update public.user_workspace_preferences
      set atelier_layout = '{"version":1,"layout":{"sizes":{"left":0,"central":100,"right":0}},"views":["secret"]}'
      where user_id = '61000000-0000-0000-0000-000000000002'$$,
  '23514',
  'new row for relation "user_workspace_preferences" violates check constraint "user_workspace_preferences_atelier_layout_v1_check"',
  'the database rejects non-layout state in account preferences'
);

set local request.jwt.claims = '{
  "sub":"61000000-0000-0000-0000-000000000002",
  "role":"authenticated",
  "aud":"authenticated",
  "client_id":"chatgpt-client",
  "resource":"https://lixray.com",
  "lixray_mcp":true
}';

select results_eq(
  'select count(*) from public.user_workspace_preferences',
  array[0::bigint],
  'MCP OAuth tokens cannot read private preferences'
);

select results_eq(
  'select count(*) from public.user_workspace_review_resolutions',
  array[0::bigint],
  'MCP OAuth tokens cannot read private review outcomes'
);

select throws_ok(
  $$insert into public.user_workspace_review_resolutions (
      user_id, workspace_id, branch_id, review_id, file_id, outcome
    ) values (
      '61000000-0000-0000-0000-000000000002',
      '63000000-0000-0000-0000-000000000001',
      'main', 'review-mcp', 'file-1', 'accepted'
    )$$,
  '42501',
  'new row violates row-level security policy for table "user_workspace_review_resolutions"',
  'MCP OAuth tokens cannot write private review outcomes'
);

reset role;
delete from public.organization_members
where organization_id = '62000000-0000-0000-0000-000000000001'
  and user_id = '61000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub = '61000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{
  "sub":"61000000-0000-0000-0000-000000000002",
  "role":"authenticated",
  "aud":"authenticated"
}';

select results_eq(
  'select count(*) from public.user_workspace_preferences',
  array[0::bigint],
  'a former member cannot read their saved workspace preference'
);

select results_eq(
  'select count(*) from public.user_workspace_review_resolutions',
  array[0::bigint],
  'a former member cannot read saved workspace review outcomes'
);

select results_eq(
  $$update public.user_workspace_preferences
      set updated_at = now()
      where user_id = '61000000-0000-0000-0000-000000000002'
      returning user_id$$,
  array[]::uuid[],
  'a former member cannot mutate their saved workspace preference'
);

select throws_ok(
  $$insert into public.user_workspace_review_resolutions (
      user_id, workspace_id, branch_id, review_id, file_id, outcome
    ) values (
      '61000000-0000-0000-0000-000000000002',
      '63000000-0000-0000-0000-000000000001',
      'main', 'review-former-member', 'file-1', 'accepted'
    )$$,
  '42501',
  'new row violates row-level security policy for table "user_workspace_review_resolutions"',
  'a former member cannot write new workspace review outcomes'
);

set local request.jwt.claim.sub = '61000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{
  "sub":"61000000-0000-0000-0000-000000000001",
  "role":"authenticated",
  "aud":"authenticated"
}';

select results_eq(
  'select count(*) from public.user_workspace_preferences',
  array[1::bigint],
  'account A remains able to read only its own preference'
);

select * from finish();
rollback;
