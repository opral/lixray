import assert from "node:assert/strict";
import test from "node:test";
import {
	activeReplicaStorage,
	replaceRepositoryReplica,
} from "./repository-replica-replacement.ts";

void test("replacement retries lost replies and publishes one retained route across competing opens", async () => {
	const entries = new Map<string, string>();
	const originalStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	const originalNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator",
	);
	let queue = Promise.resolve();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
		},
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			locks: {
				request: (
					_name: string,
					_options: unknown,
					callback: () => Promise<string>,
				) => {
					const result = queue.then(callback);
					queue = result.then(
						() => undefined,
						() => undefined,
					);
					return result;
				},
			},
		},
	});
	try {
		let replacement: string | undefined;
		let requests = 0;
		let loseReply = true;
		const options = {
			source: "old",
			failedName: "old",
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({ Authorization: "Bearer test" }),
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "DELETE")
					return new Response(null, { status: 204 });
				if (
					(input instanceof Request ? input.url : input.toString()).endsWith(
						"/sync/replica/replace",
					)
				) {
					requests++;
					const body = JSON.parse(init?.body as string) as {
						replicaId: string;
						replacementId: string;
					};
					assert.equal(body.replicaId, "old");
					replacement ??= body.replacementId;
					if (loseReply) {
						loseReply = false;
						throw new Error("lost acknowledgment");
					}
					return Response.json({ replicaId: replacement });
				}
				return Response.json({ sessionId: "session" });
			},
		};
		await assert.rejects(
			replaceRepositoryReplica(options),
			/lost acknowledgment/,
		);
		assert.equal(activeReplicaStorage("old"), "old");
		const results = await Promise.all([
			replaceRepositoryReplica(options),
			replaceRepositoryReplica(options),
		]);
		assert.deepEqual(results, [replacement, replacement]);
		assert.equal(requests, 2);
		assert.equal(activeReplicaStorage("old"), replacement);
		assert.deepEqual(
			(JSON.parse([...entries.values()][0]!) as { retainedSources: string[] })
				.retainedSources,
			["old"],
		);
	} finally {
		if (originalStorage)
			Object.defineProperty(globalThis, "localStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "localStorage");
		if (originalNavigator)
			Object.defineProperty(globalThis, "navigator", originalNavigator);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
});
