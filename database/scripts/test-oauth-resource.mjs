import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { validateMcpJwtClaims } from "../../web-app/src/mcp/auth.ts";

// Local integration test: synthetic consent, real GoTrue exchanges/refreshes.
// Tokens travel through private process pipes only; never print credentials.
const db = process.env.LIXRAY_TEST_DB_CONTAINER ?? "supabase_db_lixray";
const auth = process.env.LIXRAY_TEST_AUTH_CONTAINER ?? "supabase_auth_lixray";
const sql = (query) => {
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
				"postgres",
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
	process.env.LIXRAY_TEST_REST_CONTAINER ?? "supabase_rest_lixray";
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
		return;
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
			"http://127.0.0.1:54321/auth/v1",
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
			"http://127.0.0.1:54321/auth/v1",
			undefined,
			wrongResource,
		).error,
		"insufficient_scope",
	);
	if (initial) assert.equal(claims.session_id, initial.session_id);
	return claims;
};

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

	const first = seedAuthorization();
	const ambiguous = seedAuthorization(otherResource);
	await requestToken(first.params, false);
	assert.equal(
		sql(`select count(*) from auth.sessions where user_id='${user}';`),
		"0",
		"failed exchange rolls back its session",
	);
	sql(
		`update auth.oauth_authorizations set created_at=now()-interval '10 minutes', approved_at=now()-interval '9 minutes', expires_at=now()-interval '1 minute' where id='${ambiguous.id}';`,
	);
	await requestToken(first.params, false);
	assert.equal(
		sql(`select count(*) from auth.sessions where user_id='${user}';`),
		"0",
		"expired approved candidates also fail closed",
	);
	sql(`delete from auth.oauth_authorizations where id='${ambiguous.id}';`);
	let token = await requestToken(first.params);
	const initial = validate(token);
	assert.equal(
		sql(
			`select count(*) from auth.oauth_authorizations where id='${first.id}';`,
		),
		"0",
		"GoTrue must consume the original authorization",
	);
	assert.equal(
		sql(
			`select authorization_id from private.oauth_session_resources where session_id='${initial.session_id}';`,
		),
		first.id,
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
		"PASS: ambiguous login fails closed; exact binding survives authorization deletion and repeated refresh.",
	);

	await assertMetadataAccess(token.access_token, 1);
	const foreignAuthorization = seedAuthorization("https://unrelated.example");
	const foreignToken = await requestToken(foreignAuthorization.params);
	assert.equal(decode(foreignToken).resource, "https://unrelated.example");
	await assertMetadataAccess(foreignToken.access_token, 0);
	console.log(
		"PASS: signed foreign-resource OAuth cannot read private metadata through PostgREST or RPC.",
	);

	// Browser logout is local: the independently authorized MCP grant survives.
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

	const second = seedAuthorization(otherResource);
	token = await requestToken({
		grant_type: "refresh_token",
		refresh_token: token.refresh_token,
	});
	validate(token, initial);
	let secondToken = await requestToken(second.params);
	const secondInitial = validate(secondToken, undefined, otherResource);
	assert.notEqual(
		secondInitial.session_id,
		initial.session_id,
		"separate authorizations create separate sessions",
	);
	assert.equal(
		sql(
			`select authorization_id from private.oauth_session_resources where session_id='${secondInitial.session_id}';`,
		),
		second.id,
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
	validate(secondToken, secondInitial, otherResource);
	console.log(
		"PASS: two sessions for the same user/client retain isolated resources, including while another authorization is pending.",
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
		sql(
			`select count(*) from private.oauth_session_resources where session_id='${initial.session_id}';`,
		),
		"0",
		"revocation cascades to durable binding",
	);
	assert.equal(
		sql(
			`select count(*) from private.oauth_session_resources where session_id='${secondInitial.session_id}';`,
		),
		"0",
		"grant revocation also removes the second session binding",
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
		"PASS: actual grant revocation removes both session bindings and prevents both refreshes.",
	);

	const legacy = seedAuthorization();
	const legacyToken = await requestToken(legacy.params);
	const legacyClaims = validate(legacyToken);
	sql(
		`delete from private.oauth_session_resources where session_id='${legacyClaims.session_id}';`,
	);
	seedAuthorization(otherResource);
	await requestToken(
		{ grant_type: "refresh_token", refresh_token: legacyToken.refresh_token },
		false,
	);
	assert.equal(
		sql(
			`select count(*) from private.oauth_session_resources where session_id='${legacyClaims.session_id}';`,
		),
		"0",
	);
	console.log(
		"PASS: a legacy session without a binding cannot borrow a newer authorization.",
	);
} finally {
	sql(
		`delete from auth.oauth_clients where id in ('${client}','${otherClient}');
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
