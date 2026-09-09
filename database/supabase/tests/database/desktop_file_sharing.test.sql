begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
 ('86000000-0000-4000-8000-000000000001','desktop-share-owner@example.com','{}','{}'),
 ('86000000-0000-4000-8000-000000000002','desktop-share-other@example.com','{}','{}');
set local role authenticated;
set local request.jwt.claims='{"sub":"86000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap desktop owner');
reset role;
insert into public.lixes(id,namespace_id,name,slug)
select '86000000-0000-4000-8000-000000000011',primary_namespace_id,'Desktop','desktop' from public.accounts where id='86000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims='{"sub":"86000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"flashtype","resource":"https://lixray.com","lixray_mcp":true,"scope":"openid"}';
select is((select count(*) from public.list_accessible_lixes() where lix_id='86000000-0000-4000-8000-000000000011'),1::bigint,'desktop can discover its repository');
select lives_ok($$select public.publish_lix_resource('86000000-0000-4000-8000-000000000011','/notes/a.md','file')$$,'desktop can publish one file');
select is((select count(*) from public.list_lix_publications('86000000-0000-4000-8000-000000000011')),1::bigint,'desktop can inspect publication');
select lives_ok($$select public.unpublish_lix_resource('86000000-0000-4000-8000-000000000011','/notes/a.md','file')$$,'desktop can unpublish');
set local request.jwt.claims='{"sub":"86000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"foreign","resource":"https://unrelated.example","lixray_mcp":true,"scope":"openid"}';
select throws_ok($$select public.publish_lix_resource('86000000-0000-4000-8000-000000000011','/notes/a.md','file')$$,'P0001','Authentication required','wrong-resource OAuth cannot publish');
set local request.jwt.claims='{"sub":"86000000-0000-4000-8000-000000000002","role":"authenticated","client_id":"flashtype","resource":"https://lixray.com","lixray_mcp":true,"scope":"openid"}';
select throws_ok($$select public.publish_lix_resource('86000000-0000-4000-8000-000000000011','/notes/a.md','file')$$,'P0001','Lix access denied','unrelated account cannot publish');
select * from finish();
rollback;
