import assert from "node:assert/strict";
import test from "node:test";
import {
	activeReplicaStorage,
	replaceRepositoryReplica,
	retainedReplicaStorageNames,
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
		let lostReplies = 2;
		const requestedIds: string[] = [];
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
					requestedIds.push(body.replacementId);
					replacement ??= body.replacementId;
					if (lostReplies > 0) {
						lostReplies--;
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
		assert.equal(requests, 3);
		assert.equal(new Set(requestedIds).size, 1);
		assert.equal(activeReplicaStorage("old"), replacement);
		assert.deepEqual(retainedReplicaStorageNames("old"), ["old"]);
		assert.deepEqual(
			(
				JSON.parse(entries.get("lixray:replica-replacement:v1:old")!) as {
					retainedSources: string[];
				}
			).retainedSources,
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

async function withReplicaEnvironment(
	run: (entries: Map<string, string>) => Promise<void>,
) {
	const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const entries = new Map<string, string>();
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
				) => callback(),
			},
		},
	});
	try {
		await run(entries);
	} finally {
		if (storage) Object.defineProperty(globalThis, "localStorage", storage);
		else Reflect.deleteProperty(globalThis, "localStorage");
		if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
}

void test("recovery waits through transient admission 503 before retiring the replica", async () => {
	await withReplicaEnvironment(async () => {
		let admissions = 0;
		let replacements = 0;
		let replacement = "";
		const result = await replaceRepositoryReplica({
			source: "old",
			failedName: "old",
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({}),
			fetch: async (_input, init) => {
				if (init?.method === "DELETE")
					return new Response(null, { status: 204 });
				if (init?.method === "POST") {
					assert.equal(admissions, 2);
					replacements++;
					replacement = (
						JSON.parse(init.body as string) as { replacementId: string }
					).replacementId;
					return Response.json({ replicaId: replacement });
				}
				admissions++;
				if (admissions === 1)
					return Response.json(
						{
							error: {
								code: "LIX_ERROR_MIGRATING",
								details: { retryable: true },
							},
						},
						{ status: 503 },
					);
				return Response.json({ sessionId: "session" });
			},
		});
		assert.equal(result, replacement);
		assert.equal(replacements, 1);
		assert.equal(activeReplicaStorage("old"), replacement);
	});
});

void test("terminal admission preserves safe diagnostics and leaves local routing untouched", async () => {
	await withReplicaEnvironment(async () => {
		let requests = 0;
		await assert.rejects(
			replaceRepositoryReplica({
				source: "old",
				failedName: "old",
				url: new URL("https://example.test/lix/repository"),
				headers: async () => ({}),
				fetch: async () => {
					requests++;
					return Response.json(
						{
							error: {
								code: "LIX_ERROR_CACHE_CLEANUP",
								message: "private details",
								details: {
									retryable: false,
									admissionRetryExhausted: false,
									token: "secret",
								},
							},
						},
						{ status: 503 },
					);
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal(
					error.message,
					"Replica recovery admission returned HTTP 503 (LIX_ERROR_CACHE_CLEANUP)",
				);
				assert.deepEqual((error as Error & { details: unknown }).details, {
					httpStatus: 503,
					recoveryStage: "admission",
					recoveryAttempts: 1,
					retryable: false,
					admissionRetryExhausted: false,
				});
				return true;
			},
		);
		assert.equal(requests, 1);
		assert.equal(activeReplicaStorage("old"), "old");
	});
});

void test("replacement POST failure is never replayed and closes the admission session", async () => {
	await withReplicaEnvironment(async () => {
		const methods: string[] = [];
		await assert.rejects(
			replaceRepositoryReplica({
				source: "old",
				failedName: "old",
				url: new URL("https://example.test/lix/repository"),
				headers: async () => ({}),
				fetch: async (_input, init) => {
					methods.push(init?.method ?? "GET");
					if (init?.method === "DELETE")
						return new Response(null, { status: 204 });
					if (init?.method === "POST")
						return Response.json(
							{ error: { code: "LIX_ERROR_RECOVERING" } },
							{ status: 503 },
						);
					return Response.json({ sessionId: "session" });
				},
			}),
			{ code: "LIX_ERROR_RECOVERING", status: 503 },
		);
		assert.deepEqual(methods, ["GET", "POST", "DELETE"]);
		assert.equal(activeReplicaStorage("old"), "old");
	});
});

void test("aborting admission backoff stops recovery before replacement", async () => {
	await withReplicaEnvironment(async () => {
		const controller = new AbortController();
		let requests = 0;
		await assert.rejects(
			replaceRepositoryReplica({
				source: "old",
				failedName: "old",
				url: new URL("https://example.test/lix/repository"),
				headers: async () => ({}),
				signal: controller.signal,
				fetch: async () => {
					requests++;
					queueMicrotask(() => controller.abort(new Error("cancelled")));
					return Response.json(
						{ error: { code: "LIX_ERROR_RECOVERING" } },
						{ status: 503 },
					);
				},
			}),
			/cancelled/,
		);
		assert.equal(requests, 1);
		assert.equal(activeReplicaStorage("old"), "old");
	});
});

void test("admission deadline preserves its last cause and leaves the source active", async () => {
	await withReplicaEnvironment(async () => {
		let requests = 0;
		await assert.rejects(
			replaceRepositoryReplica({
				source: "old",
				failedName: "old",
				url: new URL("https://example.test/lix/repository"),
				headers: async () => ({}),
				signal: AbortSignal.timeout(25),
				fetch: async () => {
					requests++;
					return Response.json(
						{ error: { code: "LIX_ERROR_RECOVERING" } },
						{ status: 503 },
					);
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error && "details" in error);
				assert.deepEqual(error.details, {
					httpStatus: 503,
					recoveryStage: "admission",
					recoveryAttempts: 1,
					retryable: true,
					admissionRetryExhausted: true,
					recoveryDeadlineExceeded: true,
				});
				return true;
			},
		);
		assert.equal(requests, 1);
		assert.equal(activeReplicaStorage("old"), "old");
	});
});

void test("retryable admission can finish after the initial backoff ramp", async (t) => {
	await withReplicaEnvironment(async () => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let admissions = 0;
		let replacements = 0;
		const opening = replaceRepositoryReplica({
			source: "old",
			failedName: "old",
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({}),
			fetch: async (_input, init) => {
				if (init?.method === "DELETE")
					return new Response(null, { status: 204 });
				if (init?.method === "POST") {
					replacements++;
					const body = JSON.parse(init.body as string) as {
						replacementId: string;
					};
					return Response.json({ replicaId: body.replacementId });
				}
				admissions++;
				return admissions <= 7
					? Response.json(
							{ error: { code: "LIX_ERROR_MIGRATING" } },
							{ status: 503 },
						)
					: Response.json({ sessionId: "session" });
			},
		}).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await new Promise((resolve) => setImmediate(resolve));
		for (let tick = 0; tick < 9 && admissions < 8; tick++) {
			t.mock.timers.tick(3_000);
			await new Promise((resolve) => setImmediate(resolve));
		}
		const result = await opening;
		assert.ok("value" in result);
		assert.equal(admissions, 8);
		assert.equal(replacements, 1);
		assert.equal(activeReplicaStorage("old"), result.value);
		t.mock.timers.reset();
	});
});

void test("a route-write failure retries with the durable replacement intent", async () => {
	await withReplicaEnvironment(async (entries) => {
		const browserStorage = globalThis.localStorage as Storage & {
			setItem(key: string, value: string): void;
		};
		let rejectRouteWrite = true;
		Object.defineProperty(browserStorage, "setItem", {
			configurable: true,
			value: (key: string, value: string) => {
				if (rejectRouteWrite && !key.endsWith(":intent")) {
					throw new Error("route storage is full");
				}
				entries.set(key, value);
			},
		});
		const requestedIds: string[] = [];
		let canonicalId: string | undefined;
		const options = {
			source: "old",
			failedName: "old",
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({}),
			fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "DELETE")
					return new Response(null, { status: 204 });
				if (init?.method === "POST") {
					const body = JSON.parse(init.body as string) as {
						replicaId: string;
						replacementId: string;
					};
					assert.equal(body.replicaId, "old");
					requestedIds.push(body.replacementId);
					canonicalId ??= body.replacementId;
					return Response.json({ replicaId: canonicalId });
				}
				return Response.json({ sessionId: "session" });
			},
		};

		await assert.rejects(
			replaceRepositoryReplica(options),
			/route storage is full/,
		);
		assert.equal(activeReplicaStorage("old"), "old");
		const intent = [...entries].find(([name]) => name.endsWith(":intent"));
		assert.ok(intent);
		assert.equal(
			(JSON.parse(intent[1]) as { replacementId: string }).replacementId,
			canonicalId,
		);

		rejectRouteWrite = false;
		assert.equal(await replaceRepositoryReplica(options), canonicalId);
		assert.deepEqual(requestedIds, [canonicalId, canonicalId]);
		assert.equal(activeReplicaStorage("old"), canonicalId);
	});
});

void test("a published route permits a new intent after a crash before stale-intent cleanup", async () => {
	await withReplicaEnvironment(async () => {
		const requestedIds: string[] = [];
		const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (init?.method === "POST") {
				const body = JSON.parse(init.body as string) as {
					replicaId: string;
					replacementId: string;
				};
				requestedIds.push(body.replacementId);
				return Response.json({ replicaId: body.replacementId });
			}
			return Response.json({ sessionId: "session" });
		};
		const first = await replaceRepositoryReplica({
			source: "old",
			failedName: "old",
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({}),
			fetch,
		});
		assert.equal(activeReplicaStorage("old"), first);

		const second = await replaceRepositoryReplica({
			source: "old",
			failedName: first,
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({}),
			fetch,
		});
		assert.notEqual(second, first);
		assert.notEqual(requestedIds[1], requestedIds[0]);
		assert.deepEqual(retainedReplicaStorageNames("old"), ["old", first]);
	});
});

void test("a source-scoped canonical server identity is adopted after a legacy lost acknowledgment", async () => {
	await withReplicaEnvironment(async () => {
		const canonicalId = "old:replacement:legacy-server-choice";
		let requestedId = "";
		const result = await replaceRepositoryReplica({
			source: "old",
			failedName: "old",
			url: new URL("https://example.test/lix/repository"),
			headers: async () => ({}),
			fetch: async (_input, init) => {
				if (init?.method === "DELETE")
					return new Response(null, { status: 204 });
				if (init?.method === "POST") {
					requestedId = (
						JSON.parse(init.body as string) as { replacementId: string }
					).replacementId;
					return Response.json({ replicaId: canonicalId });
				}
				return Response.json({ sessionId: "session" });
			},
		});
		assert.notEqual(requestedId, canonicalId);
		assert.equal(result, canonicalId);
		assert.equal(activeReplicaStorage("old"), canonicalId);
	});
});

void test("a foreign authority replacement identity never changes local routing", async () => {
	await withReplicaEnvironment(async () => {
		await assert.rejects(
			replaceRepositoryReplica({
				source: "old",
				failedName: "old",
				url: new URL("https://example.test/lix/repository"),
				headers: async () => ({}),
				fetch: async (_input, init) => {
					if (init?.method === "DELETE")
						return new Response(null, { status: 204 });
					if (init?.method === "POST")
						return Response.json({
							replicaId: "other:replacement:foreign",
						});
					return Response.json({ sessionId: "session" });
				},
			}),
			/invalid replacement identity/,
		);
		assert.equal(activeReplicaStorage("old"), "old");
		assert.deepEqual(retainedReplicaStorageNames("old"), []);
	});
});

void test("retained replacement routes reject names outside their source namespace", async () => {
	await withReplicaEnvironment(async (entries) => {
		entries.set(
			"lixray:replica-replacement:v1:old",
			JSON.stringify({
				activeName: "old:replacement:active",
				retainedSources: ["other:replacement:foreign"],
			}),
		);
		assert.throws(
			() => retainedReplicaStorageNames("old"),
			/Invalid replica replacement record/,
		);
	});
});
