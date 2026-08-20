begin;

create extension if not exists pgtap with schema extensions;
select plan(1);

select is(
  to_regclass('public.user_lix_preferences')::text,
  null::text,
  'user preferences are not persisted in the control-plane database'
);

select * from finish();
rollback;
