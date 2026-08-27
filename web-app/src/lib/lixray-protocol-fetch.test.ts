import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalLixUrl,
	createLixrayProtocolFetch,
} from "./lixray-protocol-fetch.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

void test("canonical Lix URL retains the repository UUID", () => {
	assert.equal(
		canonicalLixUrl("https://lixray.example", LIX_ID).toString(),
		`https://lixray.example/lix/${LIX_ID}`,
	);
});

void test("adapts remote and sync protocol URLs to one Lixray route", async () => {
	const requests: Request[] = [];
	const forwarded: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
	const protocolFetch = createLixrayProtocolFetch({
		lixId: LIX_ID,
		namespace: "acme corp",
		repositorySlug: "launch/q3",
		fetch: async (input, init) => {
			forwarded.push({ input, init });
			requests.push(new Request(input, init));
			return new Response(null, { status: 204 });
		},
	});

	await protocolFetch(
		`https://lixray.example/lix/${LIX_ID}/lix/v1/${LIX_ID}/execute`,
		{ method: "POST", body: "remote" },
	);
	await protocolFetch(
		`https://lixray.example/lix/v1/${LIX_ID}/sync/push?limit=512`,
		{ method: "POST", body: new TextEncoder().encode("sync") },
	);

	assert.deepEqual(
		requests.map(
			(request) => `${request.method} ${new URL(request.url).pathname}`,
		),
		[
			"POST /@acme%20corp/launch%2Fq3/lix/v1/execute",
			"POST /@acme%20corp/launch%2Fq3/lix/v1/sync/push",
		],
	);
	assert.equal(await requests[0]?.text(), "remote");
	assert.equal(await requests[1]?.text(), "sync");
	assert.equal(new URL(requests[1]!.url).search, "?limit=512");
	assert.equal(forwarded[1]?.init?.body instanceof Uint8Array, true);
});

void test("rejects protocol URLs for another Lix ID", async () => {
	const protocolFetch = createLixrayProtocolFetch({
		lixId: LIX_ID,
		namespace: "acme",
		repositorySlug: "launch-q3",
		fetch: async () => new Response(null, { status: 204 }),
	});

	await assert.rejects(
		async () =>
			protocolFetch(
				"https://lixray.example/lix/v1/22222222-2222-4222-8222-222222222222/sync/pull",
			),
		/Lix protocol request does not match its canonical ID/,
	);
});
