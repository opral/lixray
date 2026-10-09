import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getLocalSupabaseSettings } from "../../scripts/local-supabase.mjs";
import { validateMcpJwtClaims } from "../../web-app/src/mcp/auth.ts";

// Local integration test: synthetic consent, real GoTrue exchanges/refreshes.
// Tokens travel through private process pipes only; never print credentials.
const { projectId, apiUrl } = getLocalSupabaseSettings();
const db = process.env.LIXRAY_TEST_DB_CONTAINER ?? `supabase_db_${projectId}`;
const auth = process.env.LIXRAY_TEST_AUTH_CONTAINER ?? `supabase_auth_${projectId}`;
const authIssuer = `${apiUrl.replace(/\/$/, "")}/auth/v1`;
const sql = (query, databaseRole = "postgres") => {
	try {
		return execFileSync(
			"docker",
			[
				"exec",
				"-i",
				db,
				"psql",
				"-X",
				"-U",
				databaseRole,
				"-d",
				"postgres",
				"-v",
				"ON_ERROR_STOP=1",
				"-At",
			],
			{
				input: query,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		).trim();
	} catch {
		// PostgreSQL error details can contain synthetic authorization codes.
		throw new Error(
			"OAuth fixture SQL failed; database details suppressed to protect credentials.",
		);
	}
};
// Re-run the actual rollout SQL over representative pre-migration records.
// All DDL and fixtures roll back, restoring the running local stack unchanged.
const checkMigration = () => {
	const migration = readFileSync(
		new URL(
			"../supabase/migrations/20260911000100_oauth_client_resource.sql",
			import.meta.url,
		),
		"utf8",
	)
		.replace(/^begin;$/m, "")
		.replace(/^commit;$/m, "");
	const migrationUser = randomUUID();
	const clients = Array.from({ length: 3 }, () => randomUUID());
	const sessions = Array.from({ length: 5 }, () => randomUUID());
	const resources = [
		"https://lixray.com",
		"https://lixray.com",
		"http://127.0.0.1:8787",
		"https://foreign.example",
	];
	const clientIndexes = [0, 1, 1, 2, 0];
	const event = (session) =>
		JSON.stringify({
			user_id: migrationUser,
			authentication_method: "token_refresh",
			claims: {
				sub: migrationUser,
				client_id: clients[0],
				session_id: session,
				scope: "openid",
			},
		});
	sql(
		`begin;
    drop trigger lixray_bind_oauth_client_resource on auth.oauth_authorizations;
    drop function private.bind_oauth_client_resource();
    drop table private.oauth_client_resources;
    drop table private.oauth_resource_policy;
    set local role postgres;
    insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
      values('${migrationUser}','migration-${migrationUser}@example.com','{}','{}');
    ${clients
			.map(
				(
					id,
				) => `insert into auth.oauth_clients(id,registration_type,redirect_uris,grant_types,client_type,token_endpoint_auth_method)
      values('${id}','dynamic','http://127.0.0.1/callback','authorization_code,refresh_token','public','none');`,
			)
			.join("\n")}
    ${sessions
			.map(
				(
					id,
					i,
				) => `insert into auth.sessions(id,user_id,oauth_client_id,scopes,created_at)
      values('${id}','${migrationUser}','${clients[clientIndexes[i]]}','openid',now()-interval '1 day');`,
			)
			.join("\n")}
    ${resources
			.map(
				(
					r,
					i,
				) => `insert into private.oauth_session_resources(session_id,user_id,client_id,authorization_id,resource,scopes)
      values('${sessions[i]}','${migrationUser}','${clients[clientIndexes[i]]}','${randomUUID()}','${r}','openid');`,
			)
			.join("\n")}
    insert into auth.oauth_authorizations(id,authorization_id,client_id,user_id,redirect_uri,scope,resource,status)
      values('${randomUUID()}','${randomUUID()}','${clients[0]}','${migrationUser}','http://127.0.0.1/callback','openid','https://foreign.example','approved'),
      ('${randomUUID()}','${randomUUID()}','${clients[0]}','${migrationUser}','http://127.0.0.1/callback','openid','https://lixray.com','pending');
    ${migration}
    do $$ begin
      if exists(select 1 from private.oauth_resource_policy where resource <> 'https://lixray.com') then
        raise exception 'Production rollout enabled a local resource'; end if;
      if (select resource from private.oauth_client_resources where client_id='${clients[0]}') is distinct from 'https://lixray.com' then
        raise exception 'Compatible client mapping was not migrated'; end if;
      if exists(select 1 from private.oauth_client_resources where client_id in ('${clients[1]}','${clients[2]}')) then
        raise exception 'Conflicting or foreign legacy resources gained a mapping'; end if;
      if exists(select 1 from auth.oauth_authorizations where user_id='${migrationUser}' and status in ('pending','approved')) then
        raise exception 'Pre-policy codes remain usable'; end if;
      if private.custom_access_token_hook('${event(sessions[0])}'::jsonb) #>> '{claims,resource}' is distinct from 'https://lixray.com' then
        raise exception 'Proven legacy session did not survive rollout'; end if;
      if private.custom_access_token_hook('${event(sessions[4])}'::jsonb) #>> '{error,http_code}' is distinct from '403' then
        raise exception 'Unbound legacy session inherited new approval'; end if;
    end $$;
    rollback;`,
		"supabase_admin",
	);
	console.log(
		"PASS: actual rollout SQL preserves proven sessions, excludes conflicting resources, and invalidates old codes without authorizing unbound sessions.",
	);
};
checkMigration();
sql(
	`insert into private.oauth_resource_policy values ('http://127.0.0.1:8787') on conflict do nothing;`,
);

const ip = execFileSync(
	"docker",
	[
		"inspect",
		auth,
		"--format",
		"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
	],
	{ encoding: "utf8" },
).trim();
const base = `http://${ip}:9999`;
const restContainer =
	process.env.LIXRAY_TEST_REST_CONTAINER ?? `supabase_rest_${projectId}`;
const restIp = execFileSync(
	"docker",
	[
		"inspect",
		restContainer,
		"--format",
		"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
	],
	{ encoding: "utf8" },
).trim();
const restBase = `http://${restIp}:3000`;
const assertMetadataAccess = async (accessToken, expectedRows) => {
	for (const path of ["/lixes?select=id,name", "/rpc/list_accessible_lixes"]) {
		const rpc = path.includes("/rpc/");
		const response = await fetch(`${restBase}${path}`, {
			method: rpc ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			...(rpc ? { body: "{}" } : {}),
		});
		assert.equal(
			response.status,
			200,
			"metadata request must return an RLS-filtered response",
		);
		const rows = await response.json();
		assert.ok(Array.isArray(rows));
		assert.equal(
			rows.length,
			expectedRows,
			"Data API and RPC must enforce the resource boundary",
		);
	}
};
const user = randomUUID(),
	client = randomUUID(),
	otherClient = randomUUID();
const redirect = "http://127.0.0.1:45678/callback";
const resource = "http://127.0.0.1:8787";
const otherResource = "http://127.0.0.1:9998";
const scope = "openid email profile offline_access";
const decode = (token) =>
	JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url"));
const requestToken = async (params, expectSuccess = true) => {
	const response = await fetch(`${base}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: client, ...params }),
	});
	const body = await response.json();
	if (!expectSuccess) {
		assert.ok(
			response.status >= 400 && response.status < 500,
			`unsafe token request must fail with 4xx, received ${response.status}`,
		);
		assert.equal(
			typeof body.access_token,
			"undefined",
			"failure must not issue credentials",
		);
		return { status: response.status, body };
	}
	assert.equal(response.status, 200, "token endpoint must succeed");
	assert.ok(
		body.access_token && body.refresh_token,
		"both tokens must be issued",
	);
	return body;
};
const seedAuthorization = (targetResource = resource) => {
	const id = randomUUID(),
		code = randomUUID();
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	sql(`insert into auth.oauth_authorizations(id,authorization_id,client_id,user_id,redirect_uri,scope,resource,status,expires_at,approved_at,authorization_code,code_challenge,code_challenge_method)
    values('${id}','${id}','${client}','${user}','${redirect}','${scope}','${targetResource}/mcp','approved',now()+interval '5 minutes',now(),'${code}','${challenge}','s256');`);
	return {
		id,
		params: {
			grant_type: "authorization_code",
			code,
			redirect_uri: redirect,
			code_verifier: verifier,
		},
	};
};
const validate = (token, initial, expectedResource = resource) => {
	const claims = decode(token);
	assert.equal(claims.resource, expectedResource);
	assert.equal(claims.client_id, client);
	assert.equal(claims.sub, user);
	assert.equal(claims.account_id, user);
	assert.equal(claims.scope, scope);
	assert.ok(claims.exp > Date.now() / 1000);
	assert.equal(
		validateMcpJwtClaims(
			claims,
			authIssuer,
			undefined,
			expectedResource,
		).ok,
		true,
	);
	const wrongResource =
		expectedResource === resource ? otherResource : resource;
	assert.equal(
		validateMcpJwtClaims(
			claims,
			authIssuer,
			undefined,
			wrongResource,
		).error,
		"insufficient_scope",
	);
	if (initial) assert.equal(claims.session_id, initial.session_id);
	return claims;
};

let dynamicClient;
try {
	sql(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values('${user}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','oauth-resource-${user.slice(0, 8)}@example.com','',now(),'{"provider":"email","providers":["email"]}','{}',now(),now());
    update auth.users set confirmation_token='', recovery_token='', email_change_token_new='', email_change='', email_change_token_current='', reauthentication_token='' where id='${user}';
    insert into auth.oauth_clients(id,client_secret_hash,registration_type,redirect_uris,grant_types,client_name,client_type,token_endpoint_auth_method)
    values('${client}','','dynamic','${redirect}','authorization_code,refresh_token','Resource regression','public','none'),
      ('${otherClient}','','dynamic','${redirect}','authorization_code,refresh_token','Wrong client regression','public','none');
    insert into auth.oauth_consents(id,user_id,client_id,scopes) values('${randomUUID()}','${user}','${client}','${scope}');`);

	// Bootstrap the identity, then explicitly seed repository metadata for this auth test.
	sql(`begin; set local role authenticated;
		select set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated"}',true);
		select * from public.bootstrap_personal_namespace(); commit;`);
	sql(`insert into public.lixes(namespace_id,name,slug)
        select primary_namespace_id,'OAuth fixture','oauth-fixture' from public.accounts where id='${user}';`);

	const password = randomUUID();
	sql(
		`update auth.users set encrypted_password=extensions.crypt('${password}',extensions.gen_salt('bf')) where id='${user}';`,
	);
	const login = await fetch(`${base}/token?grant_type=password`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: `oauth-resource-${user.slice(0, 8)}@example.com`,
			password,
		}),
	});
	assert.equal(login.status, 200, "synthetic browser login succeeds");
	const browser = await login.json();

	// Exercise registration and consent over real HTTP, including simultaneous
	// approvals for a client that has no mapping yet. No synthetic approved rows.
	const registration = await fetch(`${base}/oauth/clients/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "Local concurrent consent regression",
			redirect_uris: [redirect],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	assert.equal(registration.status, 201, "dynamic registration succeeds");
	dynamicClient = (await registration.json()).client_id;
	assert.match(dynamicClient, /^[0-9a-f-]{36}$/);
	assert.equal(
		sql(
			`select count(*) from private.oauth_client_resources where client_id='${dynamicClient}';`,
		),
		"0",
	);
	const beginConsent = async (targetResource = `${resource}/mcp`) => {
		const verifier = randomBytes(48).toString("base64url");
		const params = new URLSearchParams({
			client_id: dynamicClient,
			response_type: "code",
			redirect_uri: redirect,
			scope,
			resource: targetResource,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			state: randomUUID(),
		});
		const response = await fetch(`${base}/oauth/authorize?${params}`, {
			redirect: "manual",
		});
		assert.equal(response.status, 302);
		const authorizationRedirect = new URL(response.headers.get("location"));
		const id = authorizationRedirect.searchParams.get("authorization_id");
		// Report only protocol errors, never the redirect containing state or codes.
		const oauthError = authorizationRedirect.searchParams.get("error");
		const description =
			authorizationRedirect.searchParams.get("error_description");
		assert.ok(
			id,
			`authorize returns a consent transaction (OAuth error: ${oauthError ?? "none"}; ${description ?? "no description"})`,
		);
		const details = await fetch(`${base}/oauth/authorizations/${id}`, {
			headers: { Authorization: `Bearer ${browser.access_token}` },
		});
		return { id, verifier, details, state: params.get("state") };
	};
	const pending = await Promise.all([beginConsent(), beginConsent()]);
	for (const item of pending) assert.equal(item.details.status, 200);
	assert.equal(
		sql(
			`select count(*) from private.oauth_client_resources where client_id='${dynamicClient}';`,
		),
		"0",
		"viewing consent is not approval",
	);
	const approveConsent = async (item) => {
		const response = await fetch(
			`${base}/oauth/authorizations/${item.id}/consent`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${browser.access_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ action: "approve" }),
			},
		);
		assert.equal(response.status, 200, "real consent approval succeeds");
		const callback = new URL((await response.json()).redirect_url);
		assert.equal(callback.searchParams.get("state"), item.state);
		return requestToken({
			client_id: dynamicClient,
			grant_type: "authorization_code",
			code: callback.searchParams.get("code"),
			redirect_uri: redirect,
			code_verifier: item.verifier,
		});
	};
	const consentTokens = await Promise.all(pending.map(approveConsent));
	for (const issued of consentTokens) {
		assert.equal(decode(issued).client_id, dynamicClient);
		assert.equal(decode(issued).resource, resource);
		assert.equal(
			validateMcpJwtClaims(
				decode(issued),
				authIssuer,
				undefined,
				resource,
			).ok,
			true,
		);
		await assertMetadataAccess(issued.access_token, 1);
	}
	assert.notEqual(
		decode(consentTokens[0]).session_id,
		decode(consentTokens[1]).session_id,
	);
	// Existing consent auto-approval also runs through the database guard.
	const unsupported = await beginConsent("https://unrelated.example/mcp");
	assert.ok(
		unsupported.details.status >= 400,
		"foreign-resource auto-approval is rejected",
	);
	assert.equal(
		sql(
			`select count(*) from auth.oauth_authorizations where authorization_id='${unsupported.id}' and status='approved';`,
		),
		"0",
	);
	console.log(
		"PASS: real dynamic registration, parallel consent, code exchange, and RLS access; foreign-resource auto-approval rejected.",
	);

	assert.equal(
		sql(
			`select count(*) from private.oauth_client_resources where client_id='${client}';`,
		),
		"0",
		"registration alone grants no resource",
	);
	const first = seedAuthorization();
	const secondConcurrent = seedAuthorization();
	const abandoned = seedAuthorization();
	sql(
		`update auth.oauth_authorizations set created_at=now()-interval '10 minutes', expires_at=now()-interval '1 minute' where id='${abandoned.id}';`,
	);
	const exchanges = await Promise.all([
		requestToken(first.params),
		requestToken(secondConcurrent.params),
	]);
	let token = exchanges[0];
	const initial = validate(token);
	validate(exchanges[1]);
	assert.notEqual(initial.session_id, decode(exchanges[1]).session_id);
	assert.equal(
		sql(
			`select count(*) from auth.oauth_authorizations where id in ('${first.id}','${secondConcurrent.id}');`,
		),
		"0",
	);
	await requestToken(first.params, false);
	await requestToken(abandoned.params, false);
	console.log(
		"PASS: concurrent same-client code exchanges succeed despite an abandoned expired approval; consumed and expired codes cannot be reused.",
	);
	for (let i = 0; i < 2; i++) {
		const previousRefresh = token.refresh_token;
		token = await requestToken({
			grant_type: "refresh_token",
			refresh_token: previousRefresh,
		});
		assert.ok(
			token.refresh_token !== previousRefresh,
			"refresh must rotate its credential",
		);
		validate(token, initial);
	}
	console.log(
		"PASS: client resource survives authorization deletion and repeated refresh.",
	);

	await assertMetadataAccess(token.access_token, 1);
	assert.throws(
		() => seedAuthorization("https://unrelated.example"),
		/OAuth fixture SQL failed/,
	);
	assert.throws(
		() => seedAuthorization("https://lixray.com"),
		/OAuth fixture SQL failed/,
	);
	console.log(
		"PASS: unsupported resources and attempts to rebind a client are rejected at approval.",
	);

	// Browser logout is local: the independently authorized MCP grant survives.
	const logout = await fetch(`${base}/logout?scope=local`, {
		method: "POST",
		headers: { Authorization: `Bearer ${browser.access_token}` },
	});
	assert.equal(logout.status, 204);
	token = await requestToken({
		grant_type: "refresh_token",
		refresh_token: token.refresh_token,
	});
	validate(token, initial);
	console.log(
		"PASS: local website logout preserves the independent MCP session.",
	);

	const second = seedAuthorization();
	token = await requestToken({
		grant_type: "refresh_token",
		refresh_token: token.refresh_token,
	});
	validate(token, initial);
	let secondToken = await requestToken(second.params);
	const secondInitial = validate(secondToken);
	assert.notEqual(
		secondInitial.session_id,
		initial.session_id,
		"separate authorizations create separate sessions",
	);
	assert.equal(
		sql(
			`select count(*) from auth.oauth_authorizations where id='${second.id}';`,
		),
		"0",
	);
	token = await requestToken({
		grant_type: "refresh_token",
		refresh_token: token.refresh_token,
	});
	validate(token, initial);
	secondToken = await requestToken({
		grant_type: "refresh_token",
		refresh_token: secondToken.refresh_token,
	});
	validate(secondToken, secondInitial);
	console.log(
		"PASS: independently refreshed sessions retain the fixed client resource while other approvals exist.",
	);

	// A newly launched process receives only the persisted refresh credential.
	const child = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const { base, client, refresh } = JSON.parse(input);
    const response = await fetch(base + '/oauth/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client, grant_type: 'refresh_token', refresh_token: refresh }) });
    if (!response.ok) process.exit(1);
    process.stdout.write(JSON.stringify(await response.json()));
  `,
		],
		{
			input: JSON.stringify({ base, client, refresh: token.refresh_token }),
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	token = JSON.parse(child);
	validate(token, initial);
	token = await requestToken({
		grant_type: "refresh_token",
		refresh_token: token.refresh_token,
		resource: `${otherResource}/mcp`,
	});
	validate(token, initial);
	await requestToken(
		{
			grant_type: "refresh_token",
			refresh_token: token.refresh_token,
			client_id: otherClient,
		},
		false,
	);
	console.log(
		"PASS: refresh survives a new process and cannot change resource or client.",
	);

	const revoke = await fetch(`${base}/user/oauth/grants?client_id=${client}`, {
		method: "DELETE",
		headers: { authorization: `Bearer ${token.access_token}` },
	});
	assert.equal(
		revoke.status,
		204,
		"the actual OAuth grant revocation API must succeed",
	);
	assert.equal(
		sql(`select count(*) from auth.sessions where id='${initial.session_id}';`),
		"0",
		"revocation deletes the session",
	);
	assert.equal(
		sql(
			`select count(*) from auth.sessions where id='${secondInitial.session_id}';`,
		),
		"0",
		"grant revocation also removes the second session",
	);
	await requestToken(
		{ grant_type: "refresh_token", refresh_token: token.refresh_token },
		false,
	);
	await requestToken(
		{ grant_type: "refresh_token", refresh_token: secondToken.refresh_token },
		false,
	);
	console.log(
		"PASS: actual grant revocation removes sessions and prevents refreshes.",
	);

	const legacy = seedAuthorization();
	const legacyToken = await requestToken(legacy.params);
	const legacyClaims = validate(legacyToken);
	sql(
		`update auth.sessions set created_at=now()-interval '1 day' where id='${legacyClaims.session_id}';`,
	);
	await requestToken(
		{ grant_type: "refresh_token", refresh_token: legacyToken.refresh_token },
		false,
	);
	console.log(
		"PASS: a pre-approval session without a proven legacy binding cannot inherit client approval.",
	);
} finally {
	sql(
		`delete from auth.oauth_clients where id in ('${client}','${otherClient}','${dynamicClient ?? otherClient}');
		do $$ declare personal_namespace uuid; begin
			select primary_namespace_id into personal_namespace from public.accounts where id='${user}';
			update public.accounts set primary_namespace_id=null where id='${user}';
			delete from public.namespaces where id=personal_namespace;
			delete from auth.users where id='${user}';
			delete from public.accounts where id='${user}';
		end $$;`,
	);
	console.log("Synthetic OAuth fixtures removed.");
}
