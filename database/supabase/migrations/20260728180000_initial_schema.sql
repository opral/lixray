


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";




ALTER SCHEMA "public" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."namespace_kind" AS ENUM (
    'personal',
    'organization'
);


ALTER TYPE "public"."namespace_kind" OWNER TO "postgres";


CREATE TYPE "public"."namespace_role" AS ENUM (
    'owner',
    'member'
);


ALTER TYPE "public"."namespace_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."can_access_lix"("target_lix_id" "uuid", "target_user_id" "uuid" DEFAULT "auth"."uid"()) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select exists (
		select 1
		from public.lixes lix
		where lix.id = target_lix_id
			and lix.deleted_at is null
			and (
				private.is_namespace_member(lix.namespace_id, target_user_id)
				or exists (
					select 1 from public.lix_members
					where lix_id = target_lix_id and user_id = target_user_id
				)
			)
	);
$$;


ALTER FUNCTION "private"."can_access_lix"("target_lix_id" "uuid", "target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
	oauth_resource text;
begin
	if coalesce(claims ->> 'client_id', '') <> '' then
		select case
			when oauth_client.client_name = 'Codex LixRay_Dev'
				then 'http://127.0.0.1:8787'
			else 'https://lixray.com'
		end
		into oauth_resource
		from auth.oauth_clients as oauth_client
		where oauth_client.id = (claims ->> 'client_id')::uuid
			and oauth_client.deleted_at is null;

		-- Existing production clients predate environment-specific resources.
		oauth_resource := coalesce(nullif(oauth_resource, ''), 'https://lixray.com');
		claims := jsonb_set(claims, '{resource}', to_jsonb(oauth_resource), true);
		claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	end if;
	return jsonb_build_object('claims', claims);
end;
$$;


ALTER FUNCTION "private"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_interactive_session"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select nullif((select auth.jwt() ->> 'client_id'), '') is null;
$$;


ALTER FUNCTION "private"."is_interactive_session"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_lixray_mcp_session"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select coalesce((select auth.jwt() ->> 'lixray_mcp')::boolean, false)
		and nullif((select auth.jwt() ->> 'client_id'), '') is not null
		and (
			(select auth.jwt() ->> 'resource') = 'https://lixray.com'
			or (
				(select auth.jwt() ->> 'iss') in (
					'http://127.0.0.1:54321/auth/v1',
					'http://localhost:54321/auth/v1'
				)
				and (select auth.jwt() ->> 'resource') in (
					'http://127.0.0.1:8787',
					'http://localhost:8787'
				)
			)
		);
$$;


ALTER FUNCTION "private"."is_lixray_mcp_session"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_namespace_member"("target_namespace_id" "uuid", "target_user_id" "uuid" DEFAULT "auth"."uid"()) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select exists (
		select 1 from public.namespace_members
		where namespace_id = target_namespace_id and user_id = target_user_id
	);
$$;


ALTER FUNCTION "private"."is_namespace_member"("target_namespace_id" "uuid", "target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_namespace_owner"("target_namespace_id" "uuid", "target_user_id" "uuid" DEFAULT "auth"."uid"()) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select exists (
		select 1 from public.namespace_members
		where namespace_id = target_namespace_id
			and user_id = target_user_id
			and role = 'owner'
	);
$$;


ALTER FUNCTION "private"."is_namespace_owner"("target_namespace_id" "uuid", "target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
	new.updated_at := now();
	return new;
end;
$$;


ALTER FUNCTION "private"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."sync_auth_user_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	profile_name text;
begin
	profile_name := coalesce(
		nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
		nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
		nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
		'User'
	);

	insert into public.profiles (id, email, name, avatar_url)
	values (
		new.id,
		lower(btrim(coalesce(new.email, ''))),
		left(profile_name, 80),
		coalesce(
			nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
			nullif(new.raw_user_meta_data ->> 'picture', '')
		)
	)
	on conflict (id) do update
	set email = excluded.email,
		name = excluded.name,
		avatar_url = excluded.avatar_url;

	return new;
end;
$$;


ALTER FUNCTION "private"."sync_auth_user_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."unique_handle"("base" "text", "user_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	candidate text := coalesce(nullif(private.url_segment(base, 39), ''), 'user');
begin
	if not exists (
		select 1 from public.handles
		where squat_key = replace(candidate, '-', '')
	) then
		return candidate;
	end if;
	return left(candidate, 26) || '-' || left(replace(user_id::text, '-', ''), 12);
end;
$$;


ALTER FUNCTION "private"."unique_handle"("base" "text", "user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."url_segment"("source" "text", "max_length" integer) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
	select left(
		trim(both '-' from regexp_replace(
			regexp_replace(lower(btrim(coalesce(source, ''))), '[^a-z0-9]+', '-', 'g'),
			'-+', '-', 'g'
		)),
		max_length
	);
$$;


ALTER FUNCTION "private"."url_segment"("source" "text", "max_length" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_lix_share_token"("p_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	target_lix_id uuid;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	select token.lix_id into target_lix_id
	from public.lix_share_tokens token
	join public.lixes lix on lix.id = token.lix_id
	where token.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
		and token.revoked_at is null and token.can_edit and lix.deleted_at is null;
	if target_lix_id is null then raise exception 'Invalid or revoked share link'; end if;
	insert into public.lix_members (lix_id, user_id, role)
	values (target_lix_id, current_user_id, 'member')
	on conflict (lix_id, user_id) do nothing;
	return target_lix_id;
end;
$$;


ALTER FUNCTION "public"."accept_lix_share_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bootstrap_personal_namespace"() RETURNS TABLE("namespace_id" "uuid", "namespace_name" "text", "namespace_handle" "text", "lix_id" "uuid", "lix_name" "text", "lix_slug" "text", "created" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	profile_record public.profiles%rowtype;
	existing_namespace_id uuid;
	created_namespace_id uuid;
	claimed_handle text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;

	perform pg_advisory_xact_lock(hashtextextended('personal-namespace:' || current_user_id::text, 0));
	select primary_namespace.namespace_id into existing_namespace_id
	from public.user_primary_namespaces primary_namespace
	where primary_namespace.user_id = current_user_id;

	if existing_namespace_id is not null then
		return query
		select namespace.id, namespace.name, handle.handle,
			lix.id, lix.name, lix.slug, false
		from public.namespaces namespace
		join public.handles handle on handle.namespace_id = namespace.id
		left join lateral (
			select candidate.id, candidate.name, candidate.slug
			from public.lixes candidate
			where candidate.namespace_id = namespace.id and candidate.deleted_at is null
			order by candidate.created_at asc
			limit 1
		) lix on true
		where namespace.id = existing_namespace_id;
		return;
	end if;

	select * into profile_record from public.profiles where id = current_user_id;
	if profile_record.id is null then raise exception 'Profile not found'; end if;

	claimed_handle := private.unique_handle(
		coalesce(nullif(split_part(profile_record.email, '@', 1), ''), profile_record.name),
		current_user_id
	);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));

	insert into public.namespaces (kind, name)
	values ('personal', profile_record.name)
	returning id into created_namespace_id;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (created_namespace_id, current_user_id, 'owner');
	insert into public.user_primary_namespaces (user_id, namespace_id)
	values (current_user_id, created_namespace_id);
	insert into public.handles (handle, namespace_id)
	values (claimed_handle, created_namespace_id);

	return query select created_namespace_id, profile_record.name, claimed_handle,
		null::uuid, null::text, null::text, true;
end;
$$;


ALTER FUNCTION "public"."bootstrap_personal_namespace"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_lix_share_token"("p_lix_id" "uuid") RETURNS TABLE("token" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	token_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	token_bytes bytea := extensions.gen_random_bytes(21);
	raw_token text := '';
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if not private.can_access_lix(p_lix_id, current_user_id) then raise exception 'Lix edit access required'; end if;
	for i in 0..20 loop
		raw_token := raw_token || substr(token_alphabet, (get_byte(token_bytes, i) & 63) + 1, 1);
	end loop;
	insert into public.lix_share_tokens (lix_id, token_hash, shared_by)
	values (p_lix_id, encode(extensions.digest(raw_token, 'sha256'), 'hex'), current_user_id);
	return query select raw_token;
end;
$$;


ALTER FUNCTION "public"."create_lix_share_token"("p_lix_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_namespace"("p_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	current_user_id uuid := auth.uid();
	normalized_name text := btrim(coalesce(p_name, ''));
	new_namespace_id uuid;
	claimed_handle text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if char_length(normalized_name) not between 1 and 80 then
		raise exception 'Organization name must be between 1 and 80 characters';
	end if;
	claimed_handle := private.unique_handle(normalized_name, current_user_id);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));
	insert into public.namespaces (kind, name)
	values ('organization', normalized_name)
	returning id into new_namespace_id;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (new_namespace_id, current_user_id, 'owner');
	insert into public.handles (handle, namespace_id)
	values (claimed_handle, new_namespace_id);
	return new_namespace_id;
end;
$$;


ALTER FUNCTION "public"."create_namespace"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_lix"("p_lix_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
	if not private.is_namespace_owner((select namespace_id from public.lixes where id = p_lix_id)) then
		raise exception 'Namespace owner access required';
	end if;
	update public.lixes set deleted_at = now() where id = p_lix_id and deleted_at is null;
end;
$$;


ALTER FUNCTION "public"."delete_lix"("p_lix_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_accessible_lixes"() RETURNS TABLE("namespace_id" "uuid", "namespace_kind" "public"."namespace_kind", "namespace_name" "text", "namespace_handle" "text", "namespace_created_at" timestamp with time zone, "namespace_updated_at" timestamp with time zone, "namespace_role" "public"."namespace_role", "lix_id" "uuid", "lix_name" "text", "lix_slug" "text", "lix_created_at" timestamp with time zone, "lix_updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select namespace.id, namespace.kind, namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, namespace_member.role,
		lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at
	from public.namespaces namespace
	join public.handles handle on handle.namespace_id = namespace.id
	join public.namespace_members namespace_member
		on namespace_member.namespace_id = namespace.id and namespace_member.user_id = auth.uid()
	left join public.lixes lix
		on lix.namespace_id = namespace.id and lix.deleted_at is null
	where auth.uid() is not null
	union all
	select namespace.id, namespace.kind, namespace.name, handle.handle,
		namespace.created_at, namespace.updated_at, null::public.namespace_role,
		lix.id, lix.name, lix.slug, lix.created_at, lix.updated_at
	from public.lix_members lix_member
	join public.lixes lix on lix.id = lix_member.lix_id and lix.deleted_at is null
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	where lix_member.user_id = auth.uid()
		and not exists (
			select 1 from public.namespace_members namespace_member
			where namespace_member.namespace_id = namespace.id
				and namespace_member.user_id = auth.uid()
		)
	order by 5 asc, 10 asc;
$$;


ALTER FUNCTION "public"."list_accessible_lixes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_mcp_lix_connection"("p_lix_id" "uuid", "p_tool_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."record_mcp_lix_connection"("p_lix_id" "uuid", "p_tool_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rename_namespace"("p_namespace_id" "uuid", "p_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare normalized_name text := btrim(coalesce(p_name, ''));
begin
	if not private.is_namespace_owner(p_namespace_id) then raise exception 'Namespace owner access required'; end if;
	if char_length(normalized_name) not between 1 and 80 then raise exception 'Namespace name must be between 1 and 80 characters'; end if;
	update public.namespaces set name = normalized_name where id = p_namespace_id;
end;
$$;


ALTER FUNCTION "public"."rename_namespace"("p_namespace_id" "uuid", "p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_lix_share_token"("p_token" "text") RETURNS TABLE("namespace_id" "uuid", "namespace_name" "text", "namespace_handle" "text", "lix_id" "uuid", "lix_name" "text", "lix_slug" "text", "shared_by_name" "text", "shared_by_avatar_url" "text", "can_edit" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, profile.name, profile.avatar_url, token.can_edit
	from public.lix_share_tokens token
	join public.lixes lix on lix.id = token.lix_id
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	left join public.profiles profile on profile.id = token.shared_by
	where token.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
		and token.revoked_at is null and token.can_edit and lix.deleted_at is null;
$$;


ALTER FUNCTION "public"."resolve_lix_share_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_public_lix"("p_lix_id" "uuid") RETURNS TABLE("namespace_id" "uuid", "namespace_name" "text", "namespace_handle" "text", "lix_id" "uuid", "lix_name" "text", "lix_slug" "text", "can_edit" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, private.can_access_lix(lix.id, auth.uid())
	from public.lixes lix
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	where lix.id = p_lix_id and lix.deleted_at is null;
$$;


ALTER FUNCTION "public"."resolve_public_lix"("p_lix_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_public_lix_by_route"("p_namespace_handle" "text", "p_lix_slug" "text") RETURNS TABLE("namespace_id" "uuid", "namespace_name" "text", "namespace_handle" "text", "lix_id" "uuid", "lix_name" "text", "lix_slug" "text", "can_edit" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
	select namespace.id, namespace.name, handle.handle,
		lix.id, lix.name, lix.slug, private.can_access_lix(lix.id, auth.uid())
	from public.lixes lix
	join public.namespaces namespace on namespace.id = lix.namespace_id
	join public.handles handle on handle.namespace_id = namespace.id
	where handle.handle = lower(btrim(coalesce(p_namespace_handle, '')))
		and lix.slug = lower(btrim(coalesce(p_lix_slug, '')))
		and lix.deleted_at is null;
$$;


ALTER FUNCTION "public"."resolve_public_lix_by_route"("p_namespace_handle" "text", "p_lix_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_lix_share_token"("p_token" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare target_lix_id uuid;
begin
	select lix_id into target_lix_id from public.lix_share_tokens
	where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
	if target_lix_id is null or not private.can_access_lix(target_lix_id) then
		raise exception 'Lix edit access required';
	end if;
	update public.lix_share_tokens set revoked_at = now()
	where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end;
$$;


ALTER FUNCTION "public"."revoke_lix_share_token"("p_token" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."handles" (
    "handle" "text" NOT NULL,
    "squat_key" "text" GENERATED ALWAYS AS ("replace"("handle", '-'::"text", ''::"text")) STORED,
    "namespace_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "handles_valid" CHECK ((("handle" ~ '^[a-z0-9](?:-?[a-z0-9]){0,38}$'::"text") AND ("char_length"("handle") <= 39)))
);


ALTER TABLE "public"."handles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lix_members" (
    "lix_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."namespace_role" DEFAULT 'member'::"public"."namespace_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lix_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lix_share_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lix_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "shared_by" "uuid" NOT NULL,
    "can_edit" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "lix_share_tokens_hash_valid" CHECK (("token_hash" ~ '^[0-9a-f]{64}$'::"text"))
);


ALTER TABLE "public"."lix_share_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lixes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "namespace_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "slug_squat_key" "text" GENERATED ALWAYS AS ("replace"("slug", '-'::"text", ''::"text")) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "lixes_name_valid" CHECK ((("char_length"("btrim"("name")) >= 1) AND ("char_length"("btrim"("name")) <= 80))),
    CONSTRAINT "lixes_slug_valid" CHECK ((("slug" ~ '^[a-z0-9](?:-?[a-z0-9]){0,99}$'::"text") AND ("char_length"("slug") <= 100)))
);


ALTER TABLE "public"."lixes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mcp_lix_connections" (
    "user_id" "uuid" NOT NULL,
    "lix_id" "uuid" NOT NULL,
    "oauth_client_id" "text" NOT NULL,
    "last_tool" "text" NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "mcp_lix_connections_client_id_valid" CHECK ((("char_length"("btrim"("oauth_client_id")) >= 1) AND ("char_length"("btrim"("oauth_client_id")) <= 255))),
    CONSTRAINT "mcp_lix_connections_last_tool_valid" CHECK ((("char_length"("btrim"("last_tool")) >= 1) AND ("char_length"("btrim"("last_tool")) <= 100)))
);


ALTER TABLE "public"."mcp_lix_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."namespace_members" (
    "namespace_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."namespace_role" DEFAULT 'member'::"public"."namespace_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."namespace_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."namespaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "public"."namespace_kind" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "namespaces_name_valid" CHECK ((("char_length"("btrim"("name")) >= 1) AND ("char_length"("btrim"("name")) <= 80)))
);


ALTER TABLE "public"."namespaces" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text" NOT NULL,
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_email_normalized" CHECK (("email" = "lower"("btrim"("email")))),
    CONSTRAINT "profiles_name_valid" CHECK ((("char_length"("btrim"("name")) >= 1) AND ("char_length"("btrim"("name")) <= 80)))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_lix_preferences" (
    "user_id" "uuid" NOT NULL,
    "lix_id" "uuid" NOT NULL,
    "atelier_layout" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_lix_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_lix_review_resolutions" (
    "user_id" "uuid" NOT NULL,
    "lix_id" "uuid" NOT NULL,
    "branch_id" "text" NOT NULL,
    "review_id" "text" NOT NULL,
    "file_id" "text" NOT NULL,
    "outcome" "text" NOT NULL,
    "resolved_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_lix_review_resolutions_outcome_check" CHECK (("outcome" = ANY (ARRAY['accepted'::"text", 'rejected'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."user_lix_review_resolutions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_primary_namespaces" (
    "user_id" "uuid" NOT NULL,
    "namespace_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_primary_namespaces" OWNER TO "postgres";


ALTER TABLE ONLY "public"."handles"
    ADD CONSTRAINT "handles_namespace_id_key" UNIQUE ("namespace_id");



ALTER TABLE ONLY "public"."handles"
    ADD CONSTRAINT "handles_pkey" PRIMARY KEY ("handle");



ALTER TABLE ONLY "public"."lix_members"
    ADD CONSTRAINT "lix_members_pkey" PRIMARY KEY ("lix_id", "user_id");



ALTER TABLE ONLY "public"."lix_share_tokens"
    ADD CONSTRAINT "lix_share_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lix_share_tokens"
    ADD CONSTRAINT "lix_share_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."lixes"
    ADD CONSTRAINT "lixes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mcp_lix_connections"
    ADD CONSTRAINT "mcp_lix_connections_pkey" PRIMARY KEY ("user_id", "lix_id", "oauth_client_id");



ALTER TABLE ONLY "public"."namespace_members"
    ADD CONSTRAINT "namespace_members_pkey" PRIMARY KEY ("namespace_id", "user_id");



ALTER TABLE ONLY "public"."namespaces"
    ADD CONSTRAINT "namespaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_lix_preferences"
    ADD CONSTRAINT "user_lix_preferences_pkey" PRIMARY KEY ("user_id", "lix_id");



ALTER TABLE ONLY "public"."user_lix_review_resolutions"
    ADD CONSTRAINT "user_lix_review_resolutions_pkey" PRIMARY KEY ("user_id", "lix_id", "branch_id", "review_id", "file_id");



ALTER TABLE ONLY "public"."user_primary_namespaces"
    ADD CONSTRAINT "user_primary_namespaces_namespace_id_key" UNIQUE ("namespace_id");



ALTER TABLE ONLY "public"."user_primary_namespaces"
    ADD CONSTRAINT "user_primary_namespaces_pkey" PRIMARY KEY ("user_id");



CREATE UNIQUE INDEX "handles_squat_key_unique" ON "public"."handles" USING "btree" ("squat_key");



CREATE INDEX "lixes_namespace_id_idx" ON "public"."lixes" USING "btree" ("namespace_id");



CREATE UNIQUE INDEX "lixes_namespace_slug_squat_unique" ON "public"."lixes" USING "btree" ("namespace_id", "slug_squat_key");



CREATE UNIQUE INDEX "lixes_namespace_slug_unique" ON "public"."lixes" USING "btree" ("namespace_id", "slug");



CREATE INDEX "mcp_lix_connections_lix_last_seen_idx" ON "public"."mcp_lix_connections" USING "btree" ("lix_id", "last_seen_at" DESC);



CREATE OR REPLACE TRIGGER "lixes_set_updated_at" BEFORE UPDATE ON "public"."lixes" FOR EACH ROW EXECUTE FUNCTION "private"."set_updated_at"();



CREATE OR REPLACE TRIGGER "namespaces_set_updated_at" BEFORE UPDATE ON "public"."namespaces" FOR EACH ROW EXECUTE FUNCTION "private"."set_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."set_updated_at"();



CREATE OR REPLACE TRIGGER "user_lix_preferences_set_updated_at" BEFORE UPDATE ON "public"."user_lix_preferences" FOR EACH ROW EXECUTE FUNCTION "private"."set_updated_at"();



ALTER TABLE ONLY "public"."handles"
    ADD CONSTRAINT "handles_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lix_members"
    ADD CONSTRAINT "lix_members_lix_id_fkey" FOREIGN KEY ("lix_id") REFERENCES "public"."lixes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lix_members"
    ADD CONSTRAINT "lix_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lix_share_tokens"
    ADD CONSTRAINT "lix_share_tokens_lix_id_fkey" FOREIGN KEY ("lix_id") REFERENCES "public"."lixes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lix_share_tokens"
    ADD CONSTRAINT "lix_share_tokens_shared_by_fkey" FOREIGN KEY ("shared_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."lixes"
    ADD CONSTRAINT "lixes_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mcp_lix_connections"
    ADD CONSTRAINT "mcp_lix_connections_lix_id_fkey" FOREIGN KEY ("lix_id") REFERENCES "public"."lixes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mcp_lix_connections"
    ADD CONSTRAINT "mcp_lix_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."namespace_members"
    ADD CONSTRAINT "namespace_members_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."namespace_members"
    ADD CONSTRAINT "namespace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_lix_preferences"
    ADD CONSTRAINT "user_lix_preferences_lix_id_fkey" FOREIGN KEY ("lix_id") REFERENCES "public"."lixes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_lix_preferences"
    ADD CONSTRAINT "user_lix_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_lix_review_resolutions"
    ADD CONSTRAINT "user_lix_review_resolutions_lix_id_fkey" FOREIGN KEY ("lix_id") REFERENCES "public"."lixes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_lix_review_resolutions"
    ADD CONSTRAINT "user_lix_review_resolutions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_primary_namespaces"
    ADD CONSTRAINT "user_primary_namespaces_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_primary_namespaces"
    ADD CONSTRAINT "user_primary_namespaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."handles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "handles_select_member" ON "public"."handles" FOR SELECT TO "authenticated" USING ("private"."is_namespace_member"("namespace_id"));



ALTER TABLE "public"."lix_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lix_share_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lixes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lixes_insert_namespace_member" ON "public"."lixes" FOR INSERT TO "authenticated" WITH CHECK (("private"."is_interactive_session"() AND "private"."is_namespace_member"("namespace_id")));



CREATE POLICY "lixes_select_accessible" ON "public"."lixes" FOR SELECT TO "authenticated" USING ("private"."can_access_lix"("id"));



CREATE POLICY "lixes_update_namespace_owner" ON "public"."lixes" FOR UPDATE TO "authenticated" USING (("private"."is_interactive_session"() AND "private"."is_namespace_owner"("namespace_id"))) WITH CHECK (("private"."is_interactive_session"() AND "private"."is_namespace_owner"("namespace_id")));



ALTER TABLE "public"."mcp_lix_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mcp_lix_connections_select_owner" ON "public"."mcp_lix_connections" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_interactive_session"() AND "private"."can_access_lix"("lix_id")));



ALTER TABLE "public"."namespace_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "namespace_members_select_member" ON "public"."namespace_members" FOR SELECT TO "authenticated" USING ("private"."is_namespace_member"("namespace_id"));



ALTER TABLE "public"."namespaces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "namespaces_select_member" ON "public"."namespaces" FOR SELECT TO "authenticated" USING ("private"."is_namespace_member"("id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_self" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_interactive_session"()));



ALTER TABLE "public"."user_lix_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_lix_preferences_owner" ON "public"."user_lix_preferences" TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_interactive_session"() AND "private"."can_access_lix"("lix_id"))) WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_interactive_session"() AND "private"."can_access_lix"("lix_id")));



ALTER TABLE "public"."user_lix_review_resolutions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_lix_review_resolutions_owner" ON "public"."user_lix_review_resolutions" TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_interactive_session"() AND "private"."can_access_lix"("lix_id"))) WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_interactive_session"() AND "private"."can_access_lix"("lix_id")));



ALTER TABLE "public"."user_primary_namespaces" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "private" TO "authenticated";
GRANT USAGE ON SCHEMA "private" TO "supabase_auth_admin";



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT ALL ON SCHEMA "public" TO "service_role";




























































































































































GRANT ALL ON FUNCTION "private"."can_access_lix"("target_lix_id" "uuid", "target_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "private"."custom_access_token_hook"("event" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



GRANT ALL ON FUNCTION "private"."is_interactive_session"() TO "authenticated";



REVOKE ALL ON FUNCTION "private"."is_lixray_mcp_session"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_lixray_mcp_session"() TO "authenticated";



GRANT ALL ON FUNCTION "private"."is_namespace_member"("target_namespace_id" "uuid", "target_user_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "private"."is_namespace_owner"("target_namespace_id" "uuid", "target_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."accept_lix_share_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_lix_share_token"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."bootstrap_personal_namespace"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bootstrap_personal_namespace"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_lix_share_token"("p_lix_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_lix_share_token"("p_lix_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_namespace"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_namespace"("p_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_lix"("p_lix_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_lix"("p_lix_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_accessible_lixes"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_accessible_lixes"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_mcp_lix_connection"("p_lix_id" "uuid", "p_tool_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_mcp_lix_connection"("p_lix_id" "uuid", "p_tool_name" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."record_mcp_lix_connection"("p_lix_id" "uuid", "p_tool_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."rename_namespace"("p_namespace_id" "uuid", "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rename_namespace"("p_namespace_id" "uuid", "p_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."resolve_lix_share_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_lix_share_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_lix_share_token"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."resolve_public_lix"("p_lix_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_public_lix"("p_lix_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_public_lix"("p_lix_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."resolve_public_lix_by_route"("p_namespace_handle" "text", "p_lix_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_public_lix_by_route"("p_namespace_handle" "text", "p_lix_slug" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_public_lix_by_route"("p_namespace_handle" "text", "p_lix_slug" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."revoke_lix_share_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_lix_share_token"("p_token" "text") TO "authenticated";


















GRANT SELECT ON TABLE "public"."handles" TO "authenticated";



GRANT SELECT,INSERT ON TABLE "public"."lixes" TO "authenticated";



GRANT UPDATE("name") ON TABLE "public"."lixes" TO "authenticated";



GRANT ALL ON TABLE "public"."mcp_lix_connections" TO "service_role";
GRANT SELECT ON TABLE "public"."mcp_lix_connections" TO "authenticated";



GRANT SELECT ON TABLE "public"."namespace_members" TO "authenticated";



GRANT SELECT ON TABLE "public"."namespaces" TO "authenticated";



GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_lix_preferences" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_lix_review_resolutions" TO "authenticated";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";





























--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "auth_user_profile_sync" AFTER INSERT OR UPDATE OF "email", "raw_user_meta_data" ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "private"."sync_auth_user_profile"();
