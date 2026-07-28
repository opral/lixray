-- Persist the smallest useful MCP onboarding handshake. This is deliberately
-- metadata-only: no OAuth tokens, prompts, file contents, or tool arguments.

create table public.mcp_lix_connections (
	user_id uuid not null references auth.users(id) on delete cascade,
	lix_id uuid not null references public.lixes(id) on delete cascade,
	oauth_client_id text not null,
	last_tool text not null,
	connected_at timestamptz not null default now(),
	last_seen_at timestamptz not null default now(),
	primary key (user_id, lix_id, oauth_client_id),
	constraint mcp_lix_connections_client_id_valid check (
		char_length(btrim(oauth_client_id)) between 1 and 255
	),
	constraint mcp_lix_connections_last_tool_valid check (
		char_length(btrim(last_tool)) between 1 and 100
	)
);

create index mcp_lix_connections_lix_last_seen_idx
	on public.mcp_lix_connections(lix_id, last_seen_at desc);

create or replace function public.record_mcp_lix_connection(
	p_lix_id uuid,
	p_tool_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_user_id uuid := auth.uid();
	current_client_id text := nullif(btrim(auth.jwt() ->> 'client_id'), '');
	normalized_tool_name text := btrim(coalesce(p_tool_name, ''));
begin
	if current_user_id is null then
		raise exception 'Authentication required';
	end if;
	if not private.is_lixray_mcp_session() then
		raise exception 'LixRay MCP session required';
	end if;
	if not private.can_access_lix(p_lix_id, current_user_id) then
		raise exception 'Lix access required';
	end if;
	if char_length(normalized_tool_name) not between 1 and 100 then
		raise exception 'Tool name must be between 1 and 100 characters';
	end if;

	insert into public.mcp_lix_connections (
		user_id,
		lix_id,
		oauth_client_id,
		last_tool
	)
	values (
		current_user_id,
		p_lix_id,
		current_client_id,
		normalized_tool_name
	)
	on conflict (user_id, lix_id, oauth_client_id) do update
	set last_tool = excluded.last_tool,
		last_seen_at = now();
end;
$$;

alter table public.mcp_lix_connections enable row level security;

create policy mcp_lix_connections_select_owner
	on public.mcp_lix_connections
	for select
	to authenticated
	using (
		user_id = (select auth.uid())
		and private.is_interactive_session()
		and private.can_access_lix(lix_id)
	);

revoke all on public.mcp_lix_connections from anon, authenticated;
grant select on public.mcp_lix_connections to authenticated;

revoke all on function public.record_mcp_lix_connection(uuid, text)
	from public, anon;
grant execute on function public.record_mcp_lix_connection(uuid, text)
	to authenticated;
