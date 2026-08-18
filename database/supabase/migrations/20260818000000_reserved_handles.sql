-- Reserved handles (docs/url-schema.md §3).
--
-- Routing collisions are impossible by grammar (the @ sigil separates user
-- space from product space), so reservations are brand and anti-confusion
-- policy: nobody should be able to register @settings, @admin, or @claude.
-- The registry gains the spec's state column now so reservations live in the
-- same pool that already enforces uniqueness and anti-squatting; redirect and
-- tombstone stay unused until renames/deletion ship.

alter table public.handles
	alter column namespace_id drop not null;

alter table public.handles
	add column state text not null default 'active'
		constraint handles_state_valid
		check (state in ('active', 'redirect', 'reserved', 'tombstone')),
	add column reason text;

-- Live rows always resolve to a namespace; reserved and tombstone rows never do.
alter table public.handles
	add constraint handles_live_needs_namespace
		check (state not in ('active', 'redirect') or namespace_id is not null);

-- The lixray- prefix is wholesale reserved for the platform (spec §3 item 1);
-- exact platform and agent names are seeded as rows below.
alter table public.handles
	add constraint handles_platform_prefix
		check (state <> 'active' or handle !~ '^lixray-');

-- Pure name blocks. The squat_key index also blocks hyphenated twins of every
-- entry (sign-in via signin, and so on), so only compact forms are listed.
-- ON CONFLICT DO NOTHING keeps the migration safe on databases where a user
-- already claimed one of these before the reservation existed.
insert into public.handles (handle, state, reason)
select handle, 'reserved', 'reserved at launch (url-schema.md §3)'
from unnest(array[
	'admin', 'administrator', 'moderator', 'staff', 'root', 'system',
	'support', 'security', 'abuse', 'official', 'anonymous',
	'billing', 'settings', 'account', 'accounts', 'auth', 'oauth', 'sso',
	'login', 'logout', 'signin', 'signup',
	'api', 'app', 'www', 'mail', 'docs', 'blog', 'help', 'status',
	'home', 'dashboard', 'search', 'explore', 'new', 'edit', 'delete',
	'about', 'contact', 'legal', 'privacy', 'terms',
	'download', 'assets', 'static', 'internal',
	'profile', 'profiles', 'user', 'users', 'team', 'teams',
	'org', 'orgs', 'organization', 'organizations',
	'repo', 'repos', 'repository', 'repositories',
	'ghost', 'deleted', 'null', 'undefined',
	'lixray', 'lix', 'lixrayusercontent'
]) as handle
on conflict do nothing;

-- Agent actor names. The spec (D9) wants these as system-owned active
-- namespaces so they are mentionable; until that infrastructure exists they
-- are held as reserved rows, which the guarded state transition can later
-- flip to active without a race.
insert into public.handles (handle, state, reason)
select handle, 'reserved', 'future system-owned agent actor (url-schema.md D9)'
from unnest(array[
	'claude', 'chatgpt', 'gemini', 'codex', 'copilot', 'cursor',
	'agent', 'agents', 'bot', 'bots'
]) as handle
on conflict do nothing;
