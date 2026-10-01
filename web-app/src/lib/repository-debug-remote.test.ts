import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import {
	createRepositoryDebugRemote,
	fetchRepositoryRemoteSnapshot,
	RepositoryRemoteSnapshotError,
} from "./repository-debug-remote.ts";

void test("remote snapshots fetch the canonical endpoint without a protocol handshake", async () => {
	const requestUrl = "https://example.test/lix/v1/123e4567-e89b-12d3-a456-426614174000/snapshot";
	const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
	const snapshot = await fetchRepositoryRemoteSnapshot({
		url: requestUrl,
		headers: async () => ({ Authorization: "Bearer test-token" }),
		fetch: (async (input, init) => {
			calls.push({ input, init });
			return new Response(new Uint8Array([1, 2, 3]), {
				headers: { "Content-Type": "application/vnd.lix.snapshot" },
			});
		}) as typeof fetch,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.input, requestUrl);
	assert.equal(calls[0]?.init?.method, "GET");
	assert.equal(
		new Headers(calls[0]?.init?.headers).get("authorization"),
		"Bearer test-token",
	);
	assert.equal(
		new Headers(calls[0]?.init?.headers).get("accept"),
		"application/vnd.lix.snapshot",
	);
	assert.equal(snapshot.type, "application/vnd.lix.snapshot");
	assert.deepEqual(
		new Uint8Array(await snapshot.arrayBuffer()),
		new Uint8Array([1, 2, 3]),
	);
});

void test("remote snapshot HTTP failures retain status and a safe request id", async () => {
	let bodyCancelled = false;
	await assert.rejects(
		fetchRepositoryRemoteSnapshot({
			url: "https://example.test/lix/v1/repo-id/snapshot",
			fetch: (async () =>
				new Response(
					new ReadableStream({
						cancel() {
							bodyCancelled = true;
						},
					}),
					{
						status: 404,
						headers: { "x-request-id": "req_123" },
					},
				)
			) as typeof fetch,
		}),
		(error: unknown) => {
			assert.ok(error instanceof RepositoryRemoteSnapshotError);
			assert.match(error.message, /status 404/);
			assert.equal(error.failureStage, "http_response");
			assert.equal(error.status, 404);
			assert.equal(error.code, "HTTP_404");
			assert.equal(error.requestId, "req_123");
			return true;
		},
	);
	assert.equal(bodyCancelled, true);
});

void test("remote snapshot stream failures retain the original cause and request id", async () => {
	const streamFailure = new Error("body stream broke");
	await assert.rejects(
		fetchRepositoryRemoteSnapshot({
			url: "https://example.test/lix/v1/repo-id/snapshot",
			fetch: (async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(streamFailure);
						},
					}),
					{ headers: { "x-request-id": "body_123" } },
				)
			) as typeof fetch,
		}),
		(error: unknown) => {
			assert.ok(error instanceof RepositoryRemoteSnapshotError);
			assert.equal(error.failureStage, "response_body");
			assert.equal(error.requestId, "body_123");
			assert.equal(error.cause, streamFailure);
			return true;
		},
	);
});

void test("remote snapshot request failures retain their stage and cause", async () => {
	const requestFailure = new Error("fetch failed");
	await assert.rejects(
		fetchRepositoryRemoteSnapshot({
			url: "https://example.test/lix/v1/repo-id/snapshot",
			fetch: (async () => {
				throw requestFailure;
			}) as typeof fetch,
		}),
		(error: unknown) => {
			assert.ok(error instanceof RepositoryRemoteSnapshotError);
			assert.equal(error.failureStage, "request");
			assert.equal(error.cause, requestFailure);
			return true;
		},
	);
});

void test("remote snapshot header failures are classified before fetch", async () => {
	const headerFailure = new Error("auth refresh failed");
	let fetchCalls = 0;
	await assert.rejects(
		fetchRepositoryRemoteSnapshot({
			url: "https://example.test/lix/v1/repo-id/snapshot",
		headers: async () => {
				throw headerFailure;
			},
			fetch: (async () => {
				fetchCalls += 1;
				return new Response();
			}) as typeof fetch,
		}),
		(error: unknown) => {
			assert.ok(error instanceof RepositoryRemoteSnapshotError);
			assert.equal(error.failureStage, "request_headers");
			assert.equal(error.cause, headerFailure);
			return true;
		},
	);
	assert.equal(fetchCalls, 0);
});

void test("a failed remote open does not poison later snapshot downloads", async () => {
	let attempts = 0;
	let branchCalls = 0;
	const remote = {
		activeBranchId: async () => {
			branchCalls += 1;
			return "main";
		},
		exportSnapshot: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.close();
				},
			}),
		close: async () => undefined,
	} as unknown as Lix;
	const session = createRepositoryDebugRemote(
		async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary 404");
			return remote;
		},
		() => "main",
	);
	await assert.rejects(session.selectedBranch(), /temporary 404/);
	const snapshot = await session.snapshot();
	assert.deepEqual(
		new Uint8Array(await snapshot.arrayBuffer()),
		new Uint8Array([1, 2, 3]),
	);
	assert.equal(attempts, 2);
	assert.equal(branchCalls, 0);
	await session.close();
});

void test("snapshot export failure closes the handle and retries on next download", async () => {
	let opens = 0;
	let closes = 0;
	const session = createRepositoryDebugRemote(
		async () => {
			opens += 1;
			const attempt = opens;
			return {
				exportSnapshot: () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							if (attempt === 1) controller.error(new Error("temporary 404"));
							else {
								controller.enqueue(new Uint8Array([4]));
								controller.close();
							}
						},
					}),
				close: async () => {
					closes += 1;
				},
			} as unknown as Lix;
		},
		() => "main",
	);
	await assert.rejects(session.snapshot(), /temporary 404/);
	assert.deepEqual(
		new Uint8Array(await (await session.snapshot()).arrayBuffer()),
		new Uint8Array([4]),
	);
	assert.equal(opens, 2);
	await session.close();
	assert.equal(closes, 2);
});

void test("a branch-switch failure cannot block repository-wide snapshot export", async () => {
	let opens = 0;
	let switches = 0;
	const session = createRepositoryDebugRemote(
		async () => {
			opens += 1;
			return {
				activeBranchId: async () => "other",
				switchBranch: async () => {
					switches += 1;
					throw new Error("branch switch failed");
				},
				exportSnapshot: () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([9]));
							controller.close();
						},
					}),
				close: async () => undefined,
			} as unknown as Lix;
		},
		() => "main",
	);
	await assert.rejects(session.selectedBranch(), /branch switch failed/);
	assert.equal(switches, 1);
	assert.deepEqual(
		new Uint8Array(await (await session.snapshot()).arrayBuffer()),
		new Uint8Array([9]),
	);
	assert.equal(opens, 2);
	assert.equal(switches, 1);
	await session.close();
});
