begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users (id,email,raw_app_meta_data,raw_user_meta_data) values
 ('83000000-0000-4000-8000-000000000001','api-one@example.com','{}','{}'),
 ('83000000-0000-4000-8000-000000000002','api-two@example.com','{}','{}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap first account');
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()','bootstrap second account');
reset role;
insert into public.lixes(id,namespace_id,name,slug)
select '83000000-0000-4000-8000-000000000011',primary_namespace_id,'API one','api-one' from public.accounts where id='83000000-0000-4000-8000-000000000001';
insert into public.lixes(id,namespace_id,name,slug)
select '83000000-0000-4000-8000-000000000012',primary_namespace_id,'API two','api-two' from public.accounts where id='83000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.list_api_tokens('83000000-0000-4000-8000-000000000011')),0::bigint,'repository initially has no tokens');
do $$ begin
 perform set_config('test.one',(select row_to_json(t)::text from public.generate_api_token('83000000-0000-4000-8000-000000000011') t),true);
 perform set_config('test.two',(select row_to_json(t)::text from public.generate_api_token('83000000-0000-4000-8000-000000000011') t),true);
end $$;
select is((select count(*) from public.list_api_tokens('83000000-0000-4000-8000-000000000011')),2::bigint,'multiple tokens coexist in one repository');
select ok((current_setting('test.one')::json->>'name') ~ '^[a-z]+-[a-z]+(-[0-9]+)?$','token has a human-readable generated name');
select isnt(current_setting('test.one')::json->>'name',current_setting('test.two')::json->>'name','names distinguish tokens');
select isnt(current_setting('test.one')::json->>'id',current_setting('test.two')::json->>'id','tokens have independent ids');
select ok((current_setting('test.one')::json->>'token') ~ '^lixray_pat_[0-9a-f]{64}$','secret remains cryptographically random');
select is((current_setting('test.one')::json->>'expires_at')::timestamptz,(current_setting('test.one')::json->>'created_at')::timestamptz + interval '1 year','one-year expiry');
select is((select created_at from public.list_api_tokens('83000000-0000-4000-8000-000000000011') where id=(current_setting('test.one')::json->>'id')::uuid),(current_setting('test.one')::json->>'created_at')::timestamptz,'listing includes original creation date');
select throws_ok('select * from private.api_tokens','42501','permission denied for table api_tokens','hashes are private');
select throws_ok($$select public.generate_api_token('83000000-0000-4000-8000-000000000012')$$,'P0001','Repository access required','nonmembers cannot mint tokens');
select ok((select allowed from public.authorize_api_token(current_setting('test.one')::json->>'token','83000000-0000-4000-8000-000000000011')),'first token remains valid after second created');
select ok((select allowed from public.authorize_api_token(current_setting('test.two')::json->>'token','83000000-0000-4000-8000-000000000011')),'second token works');
select is((select allowed from public.authorize_api_token(current_setting('test.one')::json->>'token','83000000-0000-4000-8000-000000000012')),false,'scope rejects other repository');
reset role;
select is((select token_hash from private.api_tokens where id=(current_setting('test.one')::json->>'id')::uuid),extensions.digest(current_setting('test.one')::json->>'token','sha256'),'only secret digest stored');
insert into public.lix_members(lix_id,account_id,role) values
 ('83000000-0000-4000-8000-000000000012','83000000-0000-4000-8000-000000000001','member'),
 ('83000000-0000-4000-8000-000000000011','83000000-0000-4000-8000-000000000002','member');
select is((select allowed from public.authorize_api_token(current_setting('test.one')::json->>'token','83000000-0000-4000-8000-000000000012')),false,'scope still rejects another repository with membership');
set local role authenticated;
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from public.list_api_tokens('83000000-0000-4000-8000-000000000011')),0::bigint,'members cannot list another person tokens');
select lives_ok($$select public.delete_api_token('83000000-0000-4000-8000-000000000011',(current_setting('test.one')::json->>'id')::uuid)$$,'delete only affects caller-owned tokens');
select ok((select allowed from public.authorize_api_token(current_setting('test.one')::json->>'token','83000000-0000-4000-8000-000000000011')),'other member cannot delete your token');
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.delete_api_token('83000000-0000-4000-8000-000000000012',(current_setting('test.one')::json->>'id')::uuid)$$,'delete checks repository as well as token id');
select ok((select allowed from public.authorize_api_token(current_setting('test.one')::json->>'token','83000000-0000-4000-8000-000000000011')),'wrong repository delete leaves token intact');
select lives_ok($$select public.delete_api_token('83000000-0000-4000-8000-000000000011',(current_setting('test.one')::json->>'id')::uuid)$$,'delete selected token');
select is((select count(*) from public.authorize_api_token(current_setting('test.one')::json->>'token','83000000-0000-4000-8000-000000000011')),0::bigint,'deleted token immediately rejected');
select ok((select allowed from public.authorize_api_token(current_setting('test.two')::json->>'token','83000000-0000-4000-8000-000000000011')),'deleting first token preserves second');
select is((select count(*) from public.list_api_tokens('83000000-0000-4000-8000-000000000011')),1::bigint,'deleted token is no longer listed');
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"oauth-client","resource":"https://lixray.com","lixray_mcp":true}';
select throws_ok($$select public.generate_api_token('83000000-0000-4000-8000-000000000011')$$,'P0001','Interactive session required','OAuth clients cannot mint tokens');
select throws_ok($$select public.delete_api_token('83000000-0000-4000-8000-000000000011',(current_setting('test.two')::json->>'id')::uuid)$$,'P0001','Interactive session required','OAuth clients cannot delete tokens');
set local role anon;
select throws_ok($$select public.list_api_tokens('83000000-0000-4000-8000-000000000011')$$,'42501','permission denied for function list_api_tokens','anonymous listing denied');
select throws_ok($$select public.generate_api_token('83000000-0000-4000-8000-000000000011')$$,'42501','permission denied for function generate_api_token','anonymous generation denied');
select throws_ok($$select public.delete_api_token('83000000-0000-4000-8000-000000000011',(current_setting('test.two')::json->>'id')::uuid)$$,'42501','permission denied for function delete_api_token','anonymous deletion denied');
reset role;
update public.accounts set status='suspended' where id='83000000-0000-4000-8000-000000000001';
select is((select count(*) from public.authorize_api_token(current_setting('test.two')::json->>'token','83000000-0000-4000-8000-000000000011')),0::bigint,'suspended account cannot use token');
update public.accounts set status='active' where id='83000000-0000-4000-8000-000000000001';
update private.api_tokens set expires_at=statement_timestamp()-interval '1 second' where id=(current_setting('test.two')::json->>'id')::uuid;
select is((select count(*) from public.authorize_api_token(current_setting('test.two')::json->>'token','83000000-0000-4000-8000-000000000011')),0::bigint,'expired token rejected');
select is(to_regprocedure('public.revoke_api_token(uuid)'),null::regprocedure,'old bulk revocation endpoint removed');
-- Force a name collision to exercise the unique-name fallback.
create or replace function private.random_api_token_name() returns text language sql volatile set search_path to '' as $$ select 'happy-elephant'::text $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"83000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$ begin
 perform set_config('test.collision_one',(select row_to_json(t)::text from public.generate_api_token('83000000-0000-4000-8000-000000000011') t),true);
 perform set_config('test.collision_two',(select row_to_json(t)::text from public.generate_api_token('83000000-0000-4000-8000-000000000011') t),true);
end $$;
select is(current_setting('test.collision_one')::json->>'name','happy-elephant','generated human name is returned');
select is(current_setting('test.collision_two')::json->>'name','happy-elephant-2','name collisions get a readable suffix');
reset role;
delete from public.lix_members where lix_id='83000000-0000-4000-8000-000000000011' and account_id='83000000-0000-4000-8000-000000000002';
select is((select allowed from public.authorize_api_token(current_setting('test.collision_one')::json->>'token','83000000-0000-4000-8000-000000000011')),false,'removing membership denies existing named tokens');
select * from finish();
rollback;
