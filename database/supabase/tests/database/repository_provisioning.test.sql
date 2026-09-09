begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
 ('84000000-0000-4000-8000-000000000001','provision-owner@example.com','{}','{}'),
 ('84000000-0000-4000-8000-000000000002','provision-other@example.com','{}','{}');
set local role authenticated;
set local request.jwt.claims='{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','new bootstrap can insert its default repository');
select is((select count(*) from public.lixes where storage_provision_mode='create-new'),1::bigint,'new bootstrap repository explicitly creates storage');
reset role;
insert into public.lixes(id,namespace_id,name,slug)
select '84000000-0000-4000-8000-000000000011',primary_namespace_id,'Legacy','legacy' from public.accounts where id='84000000-0000-4000-8000-000000000001';
-- Model a row that existed when the additive migration backfilled adopt-only.
alter table public.lixes disable trigger guard_lix_storage_provision_mode;
update public.lixes set storage_provision_mode='adopt-existing' where id='84000000-0000-4000-8000-000000000011';
alter table public.lixes enable trigger guard_lix_storage_provision_mode;
set local role authenticated;
set local request.jwt.claims='{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select storage_provision_mode from public.resolve_lix_provision_mode('84000000-0000-4000-8000-000000000011')),'adopt-existing','owner resolves legacy adoption mode');
select throws_ok($$update public.lixes set storage_provision_mode='create-new' where id='84000000-0000-4000-8000-000000000011'$$,'42501','permission denied for table lixes','owner cannot turn missing old storage into empty new storage');
reset role;
select throws_ok($$update public.lixes set storage_provision_mode='create-new' where id='84000000-0000-4000-8000-000000000011'$$,'P0001','Repository provisioning mode is immutable','trigger also protects writes through privileged functions');
set local role authenticated;
select throws_ok($$insert into public.lixes(namespace_id,name,slug,storage_provision_mode) select namespace_id,'Spoof','spoof','adopt-existing' from public.lixes where id='84000000-0000-4000-8000-000000000011'$$,'P0001','New repositories must use explicit creation','client cannot spoof insertion mode');
do $$begin perform set_config('test.provision_token',(select token from public.generate_api_token('84000000-0000-4000-8000-000000000011')),true); end$$;
set local role anon;
set local request.jwt.claims='{"role":"anon"}';
select is((select count(*) from public.resolve_lix_provision_mode('84000000-0000-4000-8000-000000000011')),0::bigint,'anonymous caller cannot discover private provisioning state');
select is((select storage_provision_mode from public.resolve_lix_provision_mode('84000000-0000-4000-8000-000000000011',current_setting('test.provision_token'))),'adopt-existing','repository-scoped PAT resolves the same protected mode');
set local role authenticated;
set local request.jwt.claims='{"sub":"84000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap unrelated account');
select is((select count(*) from public.resolve_lix_provision_mode('84000000-0000-4000-8000-000000000011')),0::bigint,'unrelated account cannot provision repository');
select * from finish();
rollback;
