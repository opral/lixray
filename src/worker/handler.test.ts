import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, type WorkerEnv } from "./handler.ts";

test("GET /healthz returns Worker health without auth or proxying", async () => {
	let proxied = false;
	const response = await handleRequest(
		new Request("https://example.test/healthz"),
		env({
			fetch: async () => {
				proxied = true;
				return new Response(null, { status: 204 });
			},
		}),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, service: "lixray" });
	assert.equal(proxied, false);
});

test("/v1 routes return 500 when auth token is not configured", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({ token: undefined }),
	);

	assert.equal(response.status, 500);
	assert.match(await response.text(), /LIXRAY_AUTH_TOKEN/);
});

test("/v1 routes return 401 without the bearer token", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({ token: "secret" }),
	);

	assert.equal(response.status, 401);
	assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
});

test("/v1 routes with valid auth proxy to the default container", async () => {
	const calls: string[] = [];
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health", {
			headers: { Authorization: "Bearer secret" },
		}),
		env({
			token: "secret",
			getByName: (name) => {
				calls.push(name);
				return {
					fetch: async (request) => {
						calls.push(new URL(request.url).pathname);
						return new Response("proxied", { status: 299 });
					},
				};
			},
		}),
	);

	assert.equal(response.status, 299);
	assert.deepEqual(calls, ["default", "/v1/container-health"]);
});

function env(options: {
	token?: string;
	fetch?: (request: Request) => Promise<Response>;
	getByName?: WorkerEnv["SLATEDB_CONTAINER"]["getByName"];
}): WorkerEnv {
	return {
		LIXRAY_AUTH_TOKEN: options.token,
		SLATEDB_CONTAINER: {
			getByName:
				options.getByName ??
				(() => ({
					fetch:
						options.fetch ??
						(async () => new Response("proxied", { status: 200 })),
				})),
		},
	};
}
