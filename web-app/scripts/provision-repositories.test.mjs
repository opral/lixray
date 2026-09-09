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
			urls.push(String(url));
			assert.deepEqual(JSON.parse(request.body), { mode: "adopt-existing" });
			return new Response(null, { status: 200 });
		},
	});
	assert.deepEqual(urls, [
		`http://lix-private:8080/internal/repositories/${id}/provision`,
	]);
});
