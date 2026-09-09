begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
 ('85000000-0000-4000-8000-000000000001','hosted-owner@example.com','{}','{}'),
 ('85000000-0000-4000-8000-000000000002','hosted-other@example.com','{}','{}');
set local role authenticated;
set local request.jwt.claims='{"sub":"85000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap owner');
select throws_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000011','85000000-0000-4000-8000-000000000001')$$,'42501','permission denied for function register_hosted_lix','a client cannot claim a repository');
reset role;
set local request.jwt.claims='{"role":"service_role"}';
select lives_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000011','85000000-0000-4000-8000-000000000001')$$,'register server receipt');
select is((select visibility::text from public.lixes where id='85000000-0000-4000-8000-000000000011'),'private','creation is private');
select is((select role::text from public.lix_members where lix_id='85000000-0000-4000-8000-000000000011' and account_id='85000000-0000-4000-8000-000000000001'),'admin','owner has repository administration');
select lives_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000011','85000000-0000-4000-8000-000000000001')$$,'retry is successful');
select is((select count(*) from private.hosted_lix_creations where lix_id='85000000-0000-4000-8000-000000000011'),1::bigint,'single receipt');
update public.lixes set name='Renamed' where id='85000000-0000-4000-8000-000000000011';
select lives_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000011','85000000-0000-4000-8000-000000000001')$$,'later retry is successful');
select is((select name from public.lixes where id='85000000-0000-4000-8000-000000000011'),'Renamed','retry preserves later changes');
set local role authenticated;
set local request.jwt.claims='{"sub":"85000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap unrelated account');
select is((select count(*) from public.lixes where id='85000000-0000-4000-8000-000000000011'),0::bigint,'another account cannot read private repository');
reset role;
set local request.jwt.claims='{"role":"service_role"}';
select throws_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000011','85000000-0000-4000-8000-000000000002')$$,'P0001','Repository creation receipt is no longer available','receipt cannot transfer ownership');
update public.lixes set deleted_at=now() where id='85000000-0000-4000-8000-000000000011';
select throws_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000011','85000000-0000-4000-8000-000000000001')$$,'P0001','Repository creation receipt is no longer available','retry cannot resurrect deleted repository');
insert into public.lixes(id,namespace_id,name,slug)
select '85000000-0000-4000-8000-000000000099',primary_namespace_id,'Existing','existing' from public.accounts where id='85000000-0000-4000-8000-000000000001';
select throws_ok($$select public.register_hosted_lix('85000000-0000-4000-8000-000000000099','85000000-0000-4000-8000-000000000001')$$,'P0001','Repository ID already registered','cannot claim an unrelated existing ID');
select * from finish();
rollback;
