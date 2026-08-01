--
-- Team invites: the backing model for the People tab.
--
-- One persistent invite link per namespace. Anyone who opens the link joins
-- the namespace as a member — every workspace, edit access. The roster is a
-- straight namespace_members select surfaced through a SECURITY DEFINER
-- function because profiles are self-readable only under RLS. No permissions
-- yet: every member can read the link, reset it, and remove anyone.
--


CREATE TABLE IF NOT EXISTS "public"."namespace_invite_links" (
    "namespace_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "namespace_invite_links_token_valid" CHECK (("token" ~ '^tm_[A-Za-z0-9_-]{20}$'::"text"))
);


ALTER TABLE "public"."namespace_invite_links" OWNER TO "postgres";

-- The token is stored in the clear, unlike lix_share_tokens: the People tab
-- re-displays the current link to every member, so it is a member-visible,
-- resettable setting rather than a one-shot secret.


ALTER TABLE ONLY "public"."namespace_invite_links"
    ADD CONSTRAINT "namespace_invite_links_pkey" PRIMARY KEY ("namespace_id");



ALTER TABLE ONLY "public"."namespace_invite_links"
    ADD CONSTRAINT "namespace_invite_links_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."namespace_invite_links"
    ADD CONSTRAINT "namespace_invite_links_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."namespace_invite_links"
    ADD CONSTRAINT "namespace_invite_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



-- No policies on purpose: every read and write goes through the functions
-- below, so the table stays invisible to direct PostgREST access.
ALTER TABLE "public"."namespace_invite_links" ENABLE ROW LEVEL SECURITY;



CREATE OR REPLACE FUNCTION "private"."new_team_invite_token"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
	token_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	token_bytes bytea := extensions.gen_random_bytes(20);
	raw_token text := 'tm_';
begin
	for i in 0..19 loop
		raw_token := raw_token || substr(token_alphabet, (get_byte(token_bytes, i) & 63) + 1, 1);
	end loop;
	return raw_token;
end;
$$;


ALTER FUNCTION "private"."new_team_invite_token"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_namespace_invite_link"("p_namespace_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	existing_token text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_namespace_member(p_namespace_id, current_user_id) then
		raise exception 'Namespace member access required';
	end if;
	select link.token into existing_token
	from public.namespace_invite_links link
	where link.namespace_id = p_namespace_id;
	if existing_token is not null then return existing_token; end if;
	-- First reader mints the link; a concurrent first reader loses the insert
	-- race and re-selects the winner's token.
	insert into public.namespace_invite_links (namespace_id, token, created_by)
	values (p_namespace_id, private.new_team_invite_token(), current_user_id)
	on conflict (namespace_id) do nothing;
	select link.token into existing_token
	from public.namespace_invite_links link
	where link.namespace_id = p_namespace_id;
	return existing_token;
end;
$$;


ALTER FUNCTION "public"."get_namespace_invite_link"("p_namespace_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_namespace_invite_link"("p_namespace_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	rotated_token text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_namespace_member(p_namespace_id, current_user_id) then
		raise exception 'Namespace member access required';
	end if;
	insert into public.namespace_invite_links (namespace_id, token, created_by)
	values (p_namespace_id, private.new_team_invite_token(), current_user_id)
	on conflict (namespace_id) do update
	set token = excluded.token, created_by = excluded.created_by, created_at = now()
	returning token into rotated_token;
	return rotated_token;
end;
$$;


ALTER FUNCTION "public"."reset_namespace_invite_link"("p_namespace_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_namespace_members"("p_namespace_id" "uuid") RETURNS TABLE("user_id" "uuid", "name" "text", "email" "text", "avatar_url" "text", "role" "public"."namespace_role", "joined_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select member.user_id, profile.name, profile.email, profile.avatar_url,
		member.role, member.created_at
	from public.namespace_members member
	join public.profiles profile on profile.id = member.user_id
	where member.namespace_id = p_namespace_id
		and private.is_interactive_session()
		and private.is_namespace_member(p_namespace_id, auth.uid())
	order by member.created_at asc, profile.name asc;
$$;


ALTER FUNCTION "public"."list_namespace_members"("p_namespace_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_namespace_member"("p_namespace_id" "uuid", "p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.is_namespace_member(p_namespace_id, current_user_id) then
		raise exception 'Namespace member access required';
	end if;
	if p_user_id = current_user_id then
		raise exception 'You cannot remove yourself from a namespace';
	end if;
	-- The other guard rail while the roster is permissionless: a namespace can
	-- never lose its last owner.
	if exists (
		select 1 from public.namespace_members
		where namespace_id = p_namespace_id and user_id = p_user_id and role = 'owner'
	) and (
		select count(*) from public.namespace_members
		where namespace_id = p_namespace_id and role = 'owner'
	) = 1 then
		raise exception 'Cannot remove the last owner of a namespace';
	end if;
	delete from public.namespace_members
	where namespace_id = p_namespace_id and user_id = p_user_id;
end;
$$;


ALTER FUNCTION "public"."remove_namespace_member"("p_namespace_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_namespace_invite"("p_token" "text") RETURNS TABLE("namespace_id" "uuid", "namespace_name" "text", "namespace_handle" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	target_namespace_id uuid;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select link.namespace_id into target_namespace_id
	from public.namespace_invite_links link
	where link.token = coalesce(p_token, '');
	if target_namespace_id is null then raise exception 'Invalid or reset invite link'; end if;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (target_namespace_id, current_user_id, 'member')
	on conflict (namespace_id, user_id) do nothing;
	return query
	select namespace.id, namespace.name, handle.handle
	from public.namespaces namespace
	join public.handles handle on handle.namespace_id = namespace.id
	where namespace.id = target_namespace_id;
end;
$$;


ALTER FUNCTION "public"."accept_namespace_invite"("p_token" "text") OWNER TO "postgres";


REVOKE ALL ON FUNCTION "private"."new_team_invite_token"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."get_namespace_invite_link"("p_namespace_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_namespace_invite_link"("p_namespace_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reset_namespace_invite_link"("p_namespace_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_namespace_invite_link"("p_namespace_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_namespace_members"("p_namespace_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_namespace_members"("p_namespace_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."remove_namespace_member"("p_namespace_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_namespace_member"("p_namespace_id" "uuid", "p_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."accept_namespace_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_namespace_invite"("p_token" "text") TO "authenticated";
