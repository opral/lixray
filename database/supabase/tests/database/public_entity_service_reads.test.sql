begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

set local role service_role;
select lives_ok(
  $$select namespace_id from public.handles where handle = 'public-read-test' and state = 'active' limit 1$$,
  'the trusted gateway can resolve an active namespace handle'
);
select lives_ok(
  $$select id from public.lixes where slug = 'public-read-test' and deleted_at is null limit 1$$,
  'the trusted gateway can resolve a live repository before checking publication'
);
reset role;

select * from finish();
rollback;
