-- One SDK credential per canonical account. Only its SHA-256 digest persists.
create table private.api_tokens (
	account_id uuid primary key references public.accounts(id) on delete cascade,
	token_hash bytea not null unique,
	created_at timestamptz not null,
	expires_at timestamptz not null
);
alter table private.api_tokens enable row level security;
revoke all on private.api_tokens from public, anon, authenticated;

create function public.get_api_token()
returns table(created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer
set search_path to ''
as $$
begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	return query select t.created_at, t.expires_at from private.api_tokens t
	where t.account_id = private.current_account_id();
end;
$$;

create function public.generate_api_token()
returns table(token text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer
set search_path to ''
as $$
declare
	owner_id uuid := private.current_account_id();
	secret text;
	issued_at timestamptz := statement_timestamp();
begin
	if owner_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	-- Serialize generation and revocation even when no token row exists yet.
	perform 1 from public.accounts where id = owner_id for update;
	secret := 'lixray_pat_' || encode(extensions.gen_random_bytes(32), 'hex');
	insert into private.api_tokens as t (account_id, token_hash, created_at, expires_at)
	values (owner_id, extensions.digest(secret, 'sha256'), issued_at, issued_at + interval '1 year')
	on conflict (account_id) do update set
		token_hash = excluded.token_hash,
		created_at = excluded.created_at,
		expires_at = excluded.expires_at;
	return query select secret, t.created_at, t.expires_at
	from private.api_tokens t where t.account_id = owner_id;
end;
$$;

create function public.revoke_api_token()
returns void
language plpgsql security definer
set search_path to ''
as $$
declare owner_id uuid := private.current_account_id();
begin
	if owner_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	perform 1 from public.accounts where id = owner_id for update;
	delete from private.api_tokens where account_id = owner_id;
end;
$$;

-- The raw credential is required: a leaked database digest is not a credential.
-- This narrow RPC deliberately accepts anon callers and checks the credential,
-- account status, expiry and current RLS permission helper itself.
create function public.authorize_api_token(p_token text, p_lix_id uuid)
returns table(account_id uuid, kind text, profile_uri text, name text, allowed boolean)
language sql stable security definer
set search_path to ''
as $$
	select account.id, account.kind,
		'https://lixray.com/profile/' || namespace.id::text,
		coalesce(nullif(btrim(profile.document #>> '{name,full}'), ''), namespace.name, 'Account'),
		exists (
			select 1 from public.lixes lix
			where lix.id = p_lix_id and lix.deleted_at is null
				and private.can_access_lix_or_unseeded(lix.id, lix.namespace_id, account.id)
		)
	from private.api_tokens token
	join public.accounts account on account.id = token.account_id and account.status = 'active'
	left join public.namespaces namespace on namespace.id = account.primary_namespace_id
	left join public.namespace_profiles profile on profile.namespace_id = namespace.id
	where p_token ~ '^lixray_pat_[0-9a-f]{64}$'
		and token.token_hash = extensions.digest(p_token, 'sha256')
		and token.expires_at > statement_timestamp();
$$;

revoke all on function public.get_api_token() from public, anon;
revoke all on function public.generate_api_token() from public, anon;
revoke all on function public.revoke_api_token() from public, anon;
grant execute on function public.get_api_token(), public.generate_api_token(), public.revoke_api_token() to authenticated;
revoke all on function public.authorize_api_token(text, uuid) from public;
grant execute on function public.authorize_api_token(text, uuid) to anon, authenticated;
