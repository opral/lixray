begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id, email, raw_app_meta_data, raw_user_meta_data) values
 ('85000000-0000-4000-8000-000000000001', 'redirect-a@example.com', '{}', '{"full_name":"First Person"}'),
 ('85000000-0000-4000-8000-000000000002', 'redirect-b@example.com', '{}', '{"full_name":"Second Person"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"85000000-0000-4000-8000-000000000001","role":"authenticated"}';
select set_config('test.first_handle', (select namespace_handle from public.bootstrap_personal_namespace()), true);
select matches(current_setting('test.first_handle'), '^[a-z]+-[a-z]+-[0-9]{6}$', 'bootstrap assigns a readable random username');
select is(public.rename_personal_handle('first-new'), 'first-new', 'owner can change username');
select is((select namespace_handle from public.resolve_public_profile_by_handle(current_setting('test.first_handle'))),
 'first-new', 'former profile handle resolves to canonical username');
select is((select state from public.handles where handle = current_setting('test.first_handle')),
 'redirect', 'former username remains a redirect while unclaimed');

reset role;
insert into public.lixes(namespace_id, name, slug, visibility)
select primary_namespace_id, 'Public notes', 'public-notes', 'public'
from public.accounts where id = '85000000-0000-4000-8000-000000000001';
set local role anon;
select is((select namespace_handle from public.resolve_public_lix_by_route(current_setting('test.first_handle'), 'public-notes')),
 'first-new', 'former repository URL resolves to current username');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"85000000-0000-4000-8000-000000000002","role":"authenticated"}';
select set_config('test.second_handle', (select namespace_handle from public.bootstrap_personal_namespace()), true);
select is(public.rename_personal_handle(current_setting('test.first_handle')),
 current_setting('test.first_handle'), 'another account can reclaim a former username');
select is((select namespace_id from public.resolve_public_profile_by_handle(current_setting('test.first_handle'))),
 (select primary_namespace_id from public.accounts where id = '85000000-0000-4000-8000-000000000002'),
 'reclaimed username resolves to its new owner');
select is((select namespace_handle from public.resolve_public_profile_by_handle('first-new')),
 'first-new', 'former owner keeps their new username');
select is((select count(*) from public.resolve_public_lix_by_route(current_setting('test.first_handle'), 'public-notes')),
 0::bigint, 'reclaimed username no longer routes to former owner repository');
select is((select namespace_handle from public.resolve_public_lix_by_route('first-new', 'public-notes')),
 'first-new', 'former owner repository remains available at current address');

select * from finish();
rollback;
