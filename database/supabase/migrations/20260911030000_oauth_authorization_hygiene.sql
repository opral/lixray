-- OAuth hygiene: a fresh approval sweeps the client's expired, never
-- exchanged authorizations, and an account can see and forget the MCP
-- clients that connected to its repositories.
begin;

create or replace function private.bind_oauth_client_resource()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	approved_resource text;
	bound_resource text;
begin
	if new.status <> 'approved' then return new; end if;
	-- An approval that was never exchanged (the client lost the code, the
	-- browser handoff failed) keeps its row past expiry, and every retry adds
	-- one more. Nothing else reads them, so a fresh approval for the client
	-- sweeps the stale ones instead of leaving them to grow.
	delete from auth.oauth_authorizations stale
	where stale.client_id = new.client_id
		and stale.id <> new.id
		and stale.status in ('pending', 'approved')
		and stale.expires_at < clock_timestamp();
	-- Exact allowlist; canonicalize only the documented endpoint aliases.
	approved_resource := case new.resource
		when 'https://lixray.com' then 'https://lixray.com'
		when 'https://lixray.com/mcp' then 'https://lixray.com'
		when 'https://lixray.com/mcp/' then 'https://lixray.com'
		when 'http://127.0.0.1:8787' then 'http://127.0.0.1:8787'
		when 'http://127.0.0.1:8787/mcp' then 'http://127.0.0.1:8787'
		when 'http://localhost:8787' then 'http://localhost:8787'
		when 'http://localhost:8787/mcp' then 'http://localhost:8787'
		else null end;
	if approved_resource is null or new.user_id is null or not exists (
		select 1 from private.oauth_resource_policy where resource = approved_resource
	) then
		raise exception using errcode = '22023', message = 'Unsupported LixRay OAuth resource.';
	end if;
	-- Unique-key conflict serialization makes simultaneous approvals safe.
	insert into private.oauth_client_resources (client_id, resource)
	values (new.client_id, approved_resource) on conflict (client_id) do nothing;
	select resource into bound_resource from private.oauth_client_resources
	where client_id = new.client_id;
	if bound_resource is distinct from approved_resource then
		raise exception using errcode = '22023', message = 'OAuth client is already bound to another resource.';
	end if;
	return new;
end;
$$;

-- The MCP clients that have used this account, one row per client, for the
-- Connected apps settings. Supabase owns the grant itself
-- (auth.oauth.listGrants / revokeGrant); this is LixRay's record of use.
create function public.list_mcp_client_connections()
returns table(oauth_client_id text, repository_count bigint, last_tool text, last_seen_at timestamptz, connected_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	return query
	select c.oauth_client_id, count(*)::bigint,
		(array_agg(c.last_tool order by c.last_seen_at desc))[1],
		max(c.last_seen_at), min(c.connected_at)
	from public.mcp_lix_connections c
	where c.account_id = private.current_account_id()
	group by c.oauth_client_id
	order by max(c.last_seen_at) desc;
end;
$$;

-- Forget a client's connection records after its grant is revoked, so it
-- leaves the list; a new grant records it again on its next call.
create function public.forget_mcp_client(p_client_id text)
returns void language plpgsql security definer set search_path to '' as $$
begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	delete from public.mcp_lix_connections
	where account_id = private.current_account_id() and oauth_client_id = p_client_id;
end;
$$;
revoke all on function public.list_mcp_client_connections(), public.forget_mcp_client(text) from public, anon;
grant execute on function public.list_mcp_client_connections(), public.forget_mcp_client(text) to authenticated;

commit;
