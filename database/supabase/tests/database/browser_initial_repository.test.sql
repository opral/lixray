begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Accounts present before this rollout do not have their deleted repos restored.
select is((select count(*) from public.accounts where not initial_repository_provisioned),
  0::bigint, 'existing accounts have completed onboarding');

insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('87000000-0000-4000-8000-000000000001','browser-new@example.com','{}','{}');
select is((select initial_repository_provisioned from public.accounts
  where id='87000000-0000-4000-8000-000000000001'), false,
  'new browser account starts without a repository');

set local role authenticated;
set local request.jwt.claims='{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()', 'browser creates its namespace');
select is((select needs_creation from public.initial_personal_repository_state()), true,
  'new account needs its first repository');
select set_config('test.personal_namespace',
  (select namespace_id from public.initial_personal_repository_state())::text, true);

reset role;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
select lives_ok($$select public.register_hosted_lix(
  '87000000-0000-4000-8000-000000000011',
  '87000000-0000-4000-8000-000000000001',
  current_setting('test.personal_namespace')::uuid, 'repo')$$,
  'hosted lifecycle registers initial repository');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select repository_slug from public.initial_personal_repository_state()),
  'repo', 'first repository has the default slug');
select is((select needs_creation from public.initial_personal_repository_state()), false,
  'registration completes initial onboarding');

reset role;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
select lives_ok($$select public.delete_hosted_lix(
  '87000000-0000-4000-8000-000000000011',
  '87000000-0000-4000-8000-000000000001')$$,
  'owner may delete the initial repository');
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select needs_creation from public.initial_personal_repository_state()), false,
  'deleted initial repository is not recreated');
select * from finish();
rollback;
