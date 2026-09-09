import assert from "node:assert/strict";
import test from "node:test";
import { provisionRepositories } from "./provision-repositories.mjs";

const env = {
	LIXRAY_LIX_SERVICE_URL: "http://lix-private:8080",
	LIXRAY_INTERNAL_TOKEN: "private-token",
};

test("operator explicitly provisions fixed demo IDs through the private host endpoint", async () => {
	const calls = [];
	await provisionRepositories({
		mode: "create-new",
		env,
		fetchImpl: async (url, request) => {
			if (url.pathname === "/healthz")
				return new Response(null, { status: 200 });
			calls.push({ url: String(url), request });
			return new Response(null, { status: 201 });
		},
	});
	assert.equal(calls.length, 2);
	assert.equal(
		calls[0].url,
		"http://lix-private:8080/internal/repositories/00000000-0000-4000-8000-000000000002/provision",
	);
	assert.equal(calls[0].request.headers.Authorization, "Bearer private-token");
	assert.deepEqual(JSON.parse(calls[0].request.body), { mode: "create-new" });
});

test("failed adoption never falls back to creating or ignores a tombstone", async () => {
	let calls = 0;
	await assert.rejects(
		provisionRepositories({
			mode: "adopt-existing",
			env,
			fetchImpl: async (_url, request) => {
				if (_url.pathname === "/healthz")
					return new Response(null, { status: 200 });
				calls++;
				assert.deepEqual(JSON.parse(request.body), { mode: "adopt-existing" });
				return new Response(null, { status: 404 });
			},
		}),
		/HTTP 404/,
	);
	assert.equal(calls, 1);
});

test("invalid operator mode or configured ID fails before sending a request", async () => {
	const fetchImpl = async () => {
		throw new Error("must not send");
	};
	await assert.rejects(
		provisionRepositories({ mode: "auto", env, fetchImpl }),
		/Choose/,
	);
	await assert.rejects(
		provisionRepositories({
			mode: "create-new",
			env: { ...env, LIXRAY_DEMO_LIX_IDS: "../other" },
			fetchImpl,
		}),
		/ID is invalid/,
	);
});

test("explicit legacy repository IDs replace demo defaults for adoption", async () => {
	const id = "12345678-1234-4234-8234-123456789abc";
	const urls = [];
	await provisionRepositories({
		mode: "adopt-existing",
		ids: [id],
		env,
		fetchImpl: async (url, request) => {
			if (url.pathname === "/healthz")
				return new Response(null, { status: 200 });
			urls.push(String(url));
			assert.deepEqual(JSON.parse(request.body), { mode: "adopt-existing" });
			return new Response(null, { status: 200 });
		},
	});
	assert.deepEqual(urls, [
		`http://lix-private:8080/internal/repositories/${id}/provision`,
	]);
});

test("operator wakes the private service before any mutation", async () => {
	const methods = [];
	const sleeps = [];
	let attempts = 0;
	await provisionRepositories({
		mode: "create-new",
		env,
		sleepImpl: async (milliseconds) => {
			sleeps.push(milliseconds);
		},
		fetchImpl: async (url, request) => {
			methods.push(request.method);
			if (url.pathname === "/healthz") {
				assert.equal(request.headers, undefined);
				attempts++;
				if (attempts === 1) throw new TypeError("network unavailable");
				return new Response(null, { status: attempts === 2 ? 502 : 200 });
			}
			return new Response(null, { status: 201 });
		},
	});
	assert.deepEqual(methods, ["GET", "GET", "GET", "POST", "POST"]);
	assert.deepEqual(sleeps, [5000, 5000]);
});

for (const [status, expectedAttempts] of [
	[503, 6],
	[401, 1],
]) {
	test(`private readiness HTTP ${status} fails without provisioning`, async () => {
		let attempts = 0;
		await assert.rejects(
			provisionRepositories({
				mode: "create-new",
				env,
				sleepImpl: async () => {},
				fetchImpl: async (url, request) => {
					attempts++;
					assert.equal(url.pathname, "/healthz");
					assert.equal(request.method, "GET");
					return new Response(null, { status });
				},
			}),
			new RegExp(`HTTP ${status}`),
		);
		assert.equal(attempts, expectedAttempts);
	});
}
