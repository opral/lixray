begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values ('84000000-0000-4000-8000-000000000001', 'resource-boundary@example.com', '{}', '{}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('select public.bootstrap_personal_namespace()', 'interactive users can bootstrap');
reset role;
insert into public.lixes (id, namespace_id, name, slug)
select '84000000-0000-4000-8000-000000000011', primary_namespace_id, 'Boundary private', 'boundary-private'
from public.accounts where id = '84000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('test.boundary_namespace', (select namespace_id::text from public.lixes where id = '84000000-0000-4000-8000-000000000011'), true);
select set_config('test.boundary_handle', (select namespace_handle from public.list_accessible_lixes() limit 1), true);
select public.publish_lix_resource('84000000-0000-4000-8000-000000000011', '/public_%', 'directory');
select public.publish_lix_resource('84000000-0000-4000-8000-000000000011', '/back\slash', 'directory');
select set_config('test.boundary_token', (select token from public.generate_api_token()), true);
select is((select count(*) from public.lixes where id = '84000000-0000-4000-8000-000000000011'), 1::bigint, 'interactive repository read works');

set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"foreign","resource":"https://unrelated.example","lixray_mcp":true}';
select is(private.current_account_id(), null::uuid, 'foreign resource cannot resolve an authorized account');
select is(private.can_access_lix('84000000-0000-4000-8000-000000000011', '84000000-0000-4000-8000-000000000001'), false, 'explicit account argument cannot bypass resource check for repository membership');
select is(private.is_lix_admin('84000000-0000-4000-8000-000000000011', '84000000-0000-4000-8000-000000000001'), false, 'explicit account argument cannot bypass resource check for repository administration');
select is(private.is_namespace_member(current_setting('test.boundary_namespace')::uuid, '84000000-0000-4000-8000-000000000001'), false, 'explicit account argument cannot bypass resource check for namespace membership');
select is(private.is_namespace_owner(current_setting('test.boundary_namespace')::uuid, '84000000-0000-4000-8000-000000000001'), false, 'explicit account argument cannot bypass resource check for namespace ownership');
select is(private.can_access_lix_or_unseeded('84000000-0000-4000-8000-000000000099', current_setting('test.boundary_namespace')::uuid, '84000000-0000-4000-8000-000000000001'), false, 'unseeded repository fallback cannot bypass resource check');
select is((select count(*) from public.current_account()), 0::bigint, 'account RPC rejects foreign resource');
select is((select count(*) from public.accounts), 0::bigint, 'account RLS rejects foreign resource');
select is((select count(*) from public.account_logins), 0::bigint, 'login RLS rejects foreign resource');
select is((select count(*) from public.lixes), 0::bigint, 'repository RLS rejects foreign resource');
select is((select count(*) from public.namespaces), 0::bigint, 'namespace RLS rejects foreign resource');
select is((select count(*) from public.namespace_members), 0::bigint, 'membership RLS rejects foreign resource');
select is((select count(*) from public.handles), 0::bigint, 'handle RLS rejects foreign resource');
select is((select count(*) from public.list_accessible_lixes()), 0::bigint, 'list RPC rejects foreign resource');
select is((select count(*) from public.resolve_public_lix('84000000-0000-4000-8000-000000000011')), 0::bigint, 'ID resolver hides private metadata from foreign resource');
select is((select count(*) from public.resolve_public_lix_by_route(current_setting('test.boundary_handle'), 'boundary-private')), 0::bigint, 'route resolver hides private metadata from foreign resource');
select is((select count(*) from public.list_lix_publications('84000000-0000-4000-8000-000000000011')), 0::bigint, 'publication management list rejects foreign resource');
select throws_ok($$select public.delete_lix('84000000-0000-4000-8000-000000000011')$$, '42883', null, 'metadata-only deletion API is unavailable');
select results_eq($$select can_edit, role, path_public from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/public_%/readme.md')$$, $$values (false, null::public.lix_role, true)$$, 'foreign resource retains public reads without private role or edit authority');

set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"missing","lixray_mcp":true}';
select is((select count(*) from public.list_accessible_lixes()), 0::bigint, 'missing resource fails closed');
set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"local","resource":"http://localhost:8787","iss":"https://project.supabase.co/auth/v1","lixray_mcp":true}';
select is((select count(*) from public.list_accessible_lixes()), 0::bigint, 'production issuer cannot authorize a local resource');
set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"local","resource":"http://localhost:8787","iss":"http://localhost:54321/auth/v1","lixray_mcp":true}';
select is((select count(*) from public.lixes where id = '84000000-0000-4000-8000-000000000011'), 1::bigint, 'local MCP retains direct repository read');
select ok(exists(select 1 from public.list_accessible_lixes()), 'local MCP retains list RPC');
set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"production","resource":"https://lixray.com","lixray_mcp":true}';
select results_eq($$select can_edit, role from public.resolve_public_lix('84000000-0000-4000-8000-000000000011')$$, $$values (true, 'admin'::public.lix_role)$$, 'production MCP retains repository permissions');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select ok((select allowed from public.authorize_api_token(current_setting('test.boundary_token'), '84000000-0000-4000-8000-000000000011')), 'anonymous API token authorization retains independent capability');
select results_eq($$select path_public from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/public_%/deep/file.md')$$, $$values (true)$$, 'literal wildcard directory descendants remain public');
select results_eq($$select path_public from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/public_%')$$, $$values (true)$$, 'literal wildcard directory itself remains public');
select is((select count(*) from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/public_private/secret.md')), 0::bigint, 'underscore and percent cannot broaden a publication');
select is((select count(*) from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/public_%suffix/secret.md')), 0::bigint, 'directory prefix requires a slash boundary');
select results_eq($$select path_public from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/back\slash/readme.md')$$, $$values (true)$$, 'backslash directory names remain literal');
select is((select count(*) from public.resolve_public_lix('84000000-0000-4000-8000-000000000011', '/backslash/secret.md')), 0::bigint, 'backslash is not a pattern escape');
select * from finish();
rollback;
