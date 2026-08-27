import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	SignJWT,
	type JWTPayload,
} from "jose";
import { handleRequest, warmJwtVerifier, type WorkerEnv } from "./handler.ts";
import { resetRemoteJwksForTests } from "./jwt-verifier.ts";
import { MCP_RESOURCE } from "../mcp/server.ts";

const ISSUER = "https://project.supabase.co/auth/v1";
const LIX_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	resetRemoteJwksForTests();
});

void test("a valid MCP bearer still authenticates after a process restart", async () => {
	const fixture = await withSignedMcpJwt();
	try {
		const first = await postMcp(fixture.token, fixture.env, fixture.options);
		assert.equal(first.status, 200);
		assert.equal(first.reachedTransport, true);

		// Drop in-memory JWKS state the same way a Railway recycle does.
		resetRemoteJwksForTests();
		await fixture.stopJwks();

		const second = await postMcp(fixture.token, fixture.env, fixture.options);
		assert.equal(
			second.status,
			200,
			"persisted JWKS must verify the same bearer after restart",
		);
		assert.equal(second.reachedTransport, true);
	} finally {
		await fixture.cleanup();
	}
});

void test("warmup persists JWKS so a recycle without live JWKS still accepts the bearer", async () => {
	const fixture = await withSignedMcpJwt();
	try {
		await warmJwtVerifier(fixture.env);
		resetRemoteJwksForTests();
		await fixture.stopJwks();

		const response = await postMcp(fixture.token, fixture.env, fixture.options);
		assert.equal(response.status, 200);
		assert.equal(response.reachedTransport, true);
	} finally {
		await fixture.cleanup();
	}
});

void test("a JWKS outage after restart is 503, not an OAuth invalid_token 401", async () => {
	const fixture = await withSignedMcpJwt({ persistCache: false });
	try {
		const first = await postMcp(fixture.token, fixture.env, fixture.options);
		assert.equal(first.status, 200);

		resetRemoteJwksForTests();
		await fixture.stopJwks();

		const second = await postMcp(fixture.token, fixture.env, fixture.options);
		assert.equal(second.status, 503);
		assert.equal(second.reachedTransport, false);
		assert.equal(second.headers.get("www-authenticate"), null);
		assert.match(await second.text(), /temporarily unavailable/);
	} finally {
		await fixture.cleanup();
	}
});

void test("a forged MCP bearer is still 401 after restart", async () => {
	const fixture = await withSignedMcpJwt();
	try {
		const other = await generateKeyPair("ES256");
		const forged = await signMcpJwt(other.privateKey, fixture.kid);
		resetRemoteJwksForTests();

		const response = await postMcp(forged, fixture.env, fixture.options);
		assert.equal(response.status, 401);
		assert.match(
			response.headers.get("www-authenticate") ?? "",
			/error="invalid_token"/,
		);
	} finally {
		await fixture.cleanup();
	}
});

void test("Lix HTTP shares the persisted JWKS store and does not 401 on a JWKS outage", async () => {
	const fixture = await withSignedMcpJwt();
	try {
		const browserToken = await new SignJWT({
			sub: "user-123",
			role: "authenticated",
		})
			.setProtectedHeader({ alg: "ES256", kid: fixture.kid })
			.setIssuer(ISSUER)
			.setAudience("authenticated")
			.setExpirationTime("5m")
			.sign(fixture.privateKey);

		const first = await handleRequest(
			new Request(`https://lixray.com/lix/v1/${LIX_ID}/execute`, {
				method: "POST",
				headers: { Authorization: `Bearer ${browserToken}` },
				body: JSON.stringify({ sql: "select 1" }),
			}),
			fixture.env,
			{
				authorizeLix: async () => null,
				lixFetch: async () => new Response("ok"),
			},
		);
		assert.equal(first.status, 200);

		resetRemoteJwksForTests();
		await fixture.stopJwks();

		const second = await handleRequest(
			new Request(`https://lixray.com/lix/v1/${LIX_ID}/execute`, {
				method: "POST",
				headers: { Authorization: `Bearer ${browserToken}` },
				body: JSON.stringify({ sql: "select 1" }),
			}),
			fixture.env,
			{
				authorizeLix: async () => null,
				lixFetch: async () => new Response("unexpected"),
			},
		);
		assert.equal(second.status, 200);
	} finally {
		await fixture.cleanup();
	}
});

async function postMcp(
	token: string,
	env: WorkerEnv,
	options: { lixFetch: () => Promise<Response> },
) {
	let reachedTransport = false;
	const response = await handleRequest(
		new Request("https://lixray.com/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			}),
		}),
		env,
		{
			lixFetch: options.lixFetch,
			mcpTransport: async () => {
				reachedTransport = true;
				return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
			},
		},
	);
	return Object.assign(response, { reachedTransport });
}

async function withSignedMcpJwt(options: { persistCache?: boolean } = {}) {
	const persistCache = options.persistCache !== false;
	const directory = persistCache
		? await mkdtemp(join(tmpdir(), "lixray-mcp-jwks-"))
		: undefined;
	const cachePath = directory ? join(directory, "jwks-cache.json") : undefined;
	const { publicKey, privateKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const kid = await calculateJwkThumbprint(jwk);
	jwk.kid = kid;
	jwk.use = "sig";
	jwk.alg = "ES256";

	const jwks = { keys: [jwk] };
	let serving = true;
	const server = await listenJwks(() =>
		serving ? Response.json(jwks) : new Response("gone", { status: 503 }),
	);
	const env: WorkerEnv = {
		SUPABASE_URL: "https://project.supabase.co",
		SUPABASE_JWKS_URL: `${server.origin}/auth/v1/.well-known/jwks.json`,
		LIXRAY_JWKS_CACHE_PATH: cachePath,
	};
	const token = await signMcpJwt(privateKey, kid);
	return {
		token,
		env,
		kid,
		privateKey,
		options: { lixFetch: async () => new Response("unused") },
		async stopJwks() {
			serving = false;
			await server.close();
		},
		async cleanup() {
			serving = false;
			await server.close().catch(() => undefined);
			if (directory) await rm(directory, { recursive: true, force: true });
		},
	};
}

async function signMcpJwt(
	privateKey: CryptoKey,
	kid: string,
	claims: JWTPayload = {},
): Promise<string> {
	return new SignJWT({
		sub: "user-123",
		role: "authenticated",
		client_id: "chatgpt-client",
		resource: MCP_RESOURCE,
		lixray_mcp: true,
		scope: "openid email profile offline_access",
		...claims,
	})
		.setProtectedHeader({ alg: "ES256", kid })
		.setIssuer(ISSUER)
		.setAudience("authenticated")
		.setExpirationTime("5m")
		.sign(privateKey);
}

async function listenJwks(
	respond: () => Response,
): Promise<{ origin: string; close: () => Promise<void> }> {
	const server: Server = createServer((incoming, outgoing) => {
		void Promise.resolve(respond())
			.then(async (response) => {
				outgoing.statusCode = response.status;
				for (const [name, value] of response.headers) {
					outgoing.setHeader(name, value);
				}
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			})
			.catch(() => {
				outgoing.statusCode = 500;
				outgoing.end();
			});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("JWKS test server did not bind a port");
	}
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
