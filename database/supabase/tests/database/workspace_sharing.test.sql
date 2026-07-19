begin;

create extension if not exists pgtap with schema extensions;
select plan(28);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('81000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mara@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Mara"}', now(), now()),
  ('81000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jonas@acme.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Jonas"}', now(), now()),
  ('81000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alex@example.net', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Alex"}', now(), now()),
  ('81000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.org', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Outsider"}', now(), now()),
  ('81000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'later@example.org', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Later"}', now(), now());

insert into public.organizations (id, name, email_domain) values
  ('82000000-0000-0000-0000-000000000001', 'Acme', 'acme.com');

insert into public.organization_members (organization_id, user_id, role) values
  ('82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', 'owner');

insert into public.workspaces (id, organization_id, name) values
  ('83000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Launch Q3'),
  ('83000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-000000000001', 'Planning');

set local role anon;

select is(
  (select count(*) from public.resolve_public_workspace('83000000-0000-0000-0000-000000000001')),
  1::bigint,
  'an anonymous reader can resolve a live workspace by immutable id'
);

select is(
  (select can_edit from public.resolve_public_workspace('83000000-0000-0000-0000-000000000001')),
  false,
  'the immutable-id resolver keeps an anonymous reader read-only'
);

select results_eq(
  $$select workspace_slug from public.resolve_public_workspace_by_route('acme', 'launch-q3')$$,
  array['launch-q3'::text],
  'an anonymous reader can resolve the canonical namespace and workspace path'
);

select is(
  (
    select can_edit
    from public.resolve_public_workspace_by_route('acme', 'launch-q3')
  ),
  false,
  'the canonical-route resolver keeps an anonymous reader read-only'
);

select is(
  (select count(*) from public.resolve_public_workspace('83000000-0000-0000-0000-000000000099')),
  0::bigint,
  'an unknown workspace id has no public resolution'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000001",
  "role":"authenticated",
  "aud":"authenticated"
}';

select set_config(
  'test.workspace_share_token',
  (select token from public.create_workspace_share_token('83000000-0000-0000-0000-000000000001')),
  true
);

select is(
  char_length(current_setting('test.workspace_share_token')),
  21,
  'Share mints one friendly Nano-ID-style token'
);

reset role;
set local role anon;

select is(
  (select count(*) from public.resolve_workspace_share_token(current_setting('test.workspace_share_token'))),
  1::bigint,
  'an anonymous opener can resolve a valid edit link'
);

select is(
  (
    select shared_by_name
    from public.resolve_workspace_share_token(current_setting('test.workspace_share_token'))
  ),
  'Mara'::text,
  'the edit link carries its sharer for the read-only strip'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000004';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000004",
  "role":"authenticated",
  "aud":"authenticated"
}';

select throws_ok(
  $$select public.create_workspace_share_token('83000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'Workspace edit access required',
  'an unrelated account cannot mint a workspace capability'
);

set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000002",
  "role":"authenticated",
  "aud":"authenticated"
}';

select is(
  (select count(*) from public.list_accessible_workspaces()),
  0::bigint,
  'a signed-in reader has no workspace-directory entry before joining'
);

select is(
  public.accept_workspace_share_token(current_setting('test.workspace_share_token')),
  '83000000-0000-0000-0000-000000000001'::uuid,
  'any signed-in Google account can join through a valid link'
);

reset role;

select is(
  (
    select count(*)
    from public.organization_members
    where organization_id = '82000000-0000-0000-0000-000000000001'
      and user_id = '81000000-0000-0000-0000-000000000002'
  ),
  0::bigint,
  'accepting a share link does not create an organization membership'
);

select is(
  (
    select count(*)
    from public.organizations
    where personal_owner_id = '81000000-0000-0000-0000-000000000002'
  ),
  1::bigint,
  'accepting a link silently provisions a new reader personal namespace'
);

select is(
  (
    select count(*)
    from public.workspace_members
    where workspace_id = '83000000-0000-0000-0000-000000000001'
      and user_id = '81000000-0000-0000-0000-000000000002'
  ),
  1::bigint,
  'accepting a share link creates only workspace-scoped membership'
);

set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000002",
  "role":"authenticated",
  "aud":"authenticated"
}';

select results_eq(
  $$select id from public.workspaces
    where organization_id = '82000000-0000-0000-0000-000000000001'
    order by id$$,
  array['83000000-0000-0000-0000-000000000001'::uuid],
  'a direct member cannot enumerate the organization sibling workspace'
);

select results_eq(
  $$select workspace_id from public.list_accessible_workspaces()
    where organization_id = '82000000-0000-0000-0000-000000000001'$$,
  array['83000000-0000-0000-0000-000000000001'::uuid],
  'the workspace directory returns the direct member only the shared workspace'
);

select is(
  (
    select organization_role is null
    from public.list_accessible_workspaces()
    where organization_id = '82000000-0000-0000-0000-000000000001'
  ),
  true,
  'the directory does not misrepresent direct membership as an organization role'
);

select is(
  (
    select count(*)
    from public.organizations
    where id = '82000000-0000-0000-0000-000000000001'
  ),
  0::bigint,
  'a direct member cannot read the enclosing organization row'
);

select is(
  (select can_edit from public.resolve_public_workspace('83000000-0000-0000-0000-000000000001')),
  true,
  'the public resolver recognizes a signed-in direct member as an editor'
);

select is(
  (
    select can_edit
    from public.resolve_public_workspace_by_route('acme', 'launch-q3')
  ),
  true,
  'the canonical-route resolver recognizes a signed-in direct member as an editor'
);

select lives_ok(
  $$insert into public.user_workspace_preferences (
      user_id, workspace_id, atelier_layout
    ) values (
      '81000000-0000-0000-0000-000000000002',
      '83000000-0000-0000-0000-000000000001',
      '{"version":1,"layout":{"sizes":{"left":20,"central":80,"right":0}}}'
    )$$,
  'a direct member can persist their own Atelier preferences'
);

select set_config(
  'test.direct_workspace_share_token',
  (select token from public.create_workspace_share_token('83000000-0000-0000-0000-000000000001')),
  true
);

select is(
  char_length(current_setting('test.direct_workspace_share_token')),
  21,
  'a joined member can become a sender'
);

reset role;
set local role anon;

select is(
  (
    select shared_by_name
    from public.resolve_workspace_share_token(
      current_setting('test.direct_workspace_share_token')
    )
  ),
  'Jonas'::text,
  'a joined member token identifies the joined member as its sharer'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000003';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000003",
  "role":"authenticated",
  "aud":"authenticated"
}';

select is(
  public.accept_workspace_share_token(current_setting('test.workspace_share_token')),
  '83000000-0000-0000-0000-000000000001'::uuid,
  'a link is reusable and never bound to a recipient email'
);

set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000001",
  "role":"authenticated",
  "aud":"authenticated"
}';

select lives_ok(
  $$select public.revoke_workspace_share_token(current_setting('test.workspace_share_token'))$$,
  'the sharer can revoke their capability without expiring it by default'
);

reset role;
set local role anon;

select is(
  (select count(*) from public.resolve_workspace_share_token(current_setting('test.workspace_share_token'))),
  0::bigint,
  'a revoked capability degrades to no join grant'
);

select is(
  (select count(*) from public.resolve_public_workspace('83000000-0000-0000-0000-000000000001')),
  1::bigint,
  'a revoked capability still degrades to the public read view'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000005';
set local request.jwt.claims = '{
  "sub":"81000000-0000-0000-0000-000000000005",
  "role":"authenticated",
  "aud":"authenticated"
}';

select throws_ok(
  $$select public.accept_workspace_share_token(current_setting('test.workspace_share_token'))$$,
  'P0001',
  'Workspace share link is invalid or revoked',
  'a revoked capability cannot add another workspace member'
);

select * from finish();
rollback;
