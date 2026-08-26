-- Account-level signup capture.
--
-- `lixray_user_signed_up` is not a web UI event. It fires once when a
-- LixRay account is created, from every client (web OAuth or MCP). The
-- browser callback and localStorage cannot see MCP-first accounts and
-- cannot enforce once-per-account.
--
-- Existing profiles are marked captured so returning logins after deploy
-- do not emit a false signup.

create table private.lixray_signup_captures (
	user_id uuid primary key references auth.users(id) on delete cascade,
	captured_at timestamptz not null default now()
);

alter table private.lixray_signup_captures enable row level security;

revoke all on table private.lixray_signup_captures from public, anon, authenticated;

insert into private.lixray_signup_captures (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

create function public.claim_lixray_user_signup()
returns table(claimed boolean, email text, name text)
language plpgsql
security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	profile_email text;
	profile_name text;
	inserted_user_id uuid;
begin
	if current_user_id is null then
		raise exception 'Authentication required';
	end if;

	select profile.email, profile.name
	into profile_email, profile_name
	from public.profiles as profile
	where profile.id = current_user_id;

	if not found then
		return query select false, null::text, null::text;
		return;
	end if;

	insert into private.lixray_signup_captures (user_id)
	values (current_user_id)
	on conflict (user_id) do nothing
	returning user_id into inserted_user_id;

	return query select
		inserted_user_id is not null,
		profile_email,
		profile_name;
end;
$$;

revoke all on function public.claim_lixray_user_signup() from public;
grant execute on function public.claim_lixray_user_signup() to authenticated;
