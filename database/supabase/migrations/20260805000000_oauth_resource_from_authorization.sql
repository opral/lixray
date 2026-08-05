CREATE OR REPLACE FUNCTION "private"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
	claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
	oauth_client_id uuid := nullif(claims ->> 'client_id', '')::uuid;
	oauth_user_id uuid := nullif(
		coalesce(event ->> 'user_id', claims ->> 'sub'),
		''
	)::uuid;
	oauth_resource text := nullif(btrim(claims ->> 'resource'), '');
begin
	if oauth_client_id is not null then
		if oauth_resource is null then
			select oauth_authorization.resource
			into oauth_resource
			from auth.oauth_authorizations as oauth_authorization
			where oauth_authorization.client_id = oauth_client_id
				and (
					oauth_user_id is null or oauth_authorization.user_id = oauth_user_id
				)
				and oauth_authorization.status = 'approved'
			order by oauth_authorization.approved_at desc nulls last,
				oauth_authorization.created_at desc
			limit 1;
		end if;

		-- MCP resource URLs are advertised with the endpoint path while JWT
		-- validation compares the resource origin.
		oauth_resource := regexp_replace(
			regexp_replace(btrim(coalesce(oauth_resource, '')), '/+$', ''),
			'/mcp$',
			''
		);
		if oauth_resource <> '' then
			claims := jsonb_set(
				claims,
				'{resource}',
				to_jsonb(oauth_resource),
				true
			);
		end if;
		claims := jsonb_set(claims, '{lixray_mcp}', 'true'::jsonb, true);
	end if;
	return jsonb_build_object('claims', claims);
end;
$$;

ALTER FUNCTION "private"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";
