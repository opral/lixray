import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchContainerWithRetry,
	isRetryableContainerError,
	type ContainerNamespace,
} from "./container-retry.ts";

void test("structured Cloudflare retry metadata takes precedence over message fallbacks", () => {
	const retryable = Object.assign(new Error("Unrecognized platform failure"), {
		retryable: true,
	});
	assert.equal(isRetryableContainerError(retryable), true);

	const terminal = Object.assign(new Error("The container is not running"), {
		retryable: false,
	});
	assert.equal(isRetryableContainerError(terminal), false);

	const overloaded = Object.assign(new Error("The container is not running"), {
		retryable: true,
		overloaded: true,
	});
	assert.equal(isRetryableContainerError(overloaded), false);
});

void test("DataCloneError and non-zero container exits are terminal", () => {
	const dataCloneError = new DOMException(
		"AbortSignal serialization is not enabled.",
		"DataCloneError",
	);
	Object.assign(dataCloneError, { retryable: true });
	assert.equal(isRetryableContainerError(dataCloneError), false);
	assert.equal(
		isRetryableContainerError(
			Object.assign(new Error("Container exited; exit code: 2"), {
				retryable: true,
			}),
		),
		false,
	);
});

void test("startup retries structured retryable errors and reacquires the stub", async () => {
	let acquisitions = 0;
	let fetches = 0;
	const response = await fetchContainerWithRetry({
		namespace: namespace(() => {
			acquisitions += 1;
			return {
				startAndWaitForPorts: async () => {
					if (acquisitions === 1) {
						throw Object.assign(new Error("Unrecognized platform failure"), {
							retryable: true,
						});
					}
				},
				fetch: async () => {
					fetches += 1;
					return new Response("ok");
				},
			};
		}),
		workspaceId: "workspace",
		operation: "POST /lix/v1/execute",
		envVars: {},
		createRequest: () => new Request("https://container.test/lix/v1/execute"),
		requestReplay: "unsafe",
		retryDelay: async () => undefined,
	});

	assert.equal(await response.text(), "ok");
	assert.equal(acquisitions, 2);
	assert.equal(fetches, 1);
});

void test("overloaded startup errors return backpressure without retrying", async () => {
	let acquisitions = 0;
	const overloaded = Object.assign(new Error("Container overloaded"), {
		retryable: true,
		overloaded: true,
	});
	await assert.rejects(
		fetchContainerWithRetry({
			namespace: namespace(() => {
				acquisitions += 1;
				return {
					startAndWaitForPorts: async () => Promise.reject(overloaded),
					fetch: async () => new Response("unreachable"),
				};
			}),
			workspaceId: "workspace",
			operation: "GET /lix/v1/",
			envVars: {},
			createRequest: () => new Request("https://container.test/lix/v1/"),
			requestReplay: "safe",
			retryDelay: async () => undefined,
		}),
		(error: unknown) => error === overloaded,
	);
	assert.equal(acquisitions, 1);
});

void test("safe requests retry ambiguous transport failures", async () => {
	let acquisitions = 0;
	const response = await fetchContainerWithRetry({
		namespace: namespace(() => {
			acquisitions += 1;
			return {
				fetch: async () => {
					if (acquisitions === 1) {
						throw Object.assign(new Error("Connection failed"), {
							retryable: true,
						});
					}
					return new Response("ok");
				},
			};
		}),
		workspaceId: "workspace",
		operation: "GET /lix/v1/",
		envVars: {},
		createRequest: () => new Request("https://container.test/lix/v1/"),
		requestReplay: "safe",
		retryDelay: async () => undefined,
	});

	assert.equal(await response.text(), "ok");
	assert.equal(acquisitions, 2);
});

void test("unsafe requests do not replay after ambiguous dispatch failures", async () => {
	let acquisitions = 0;
	const failure = Object.assign(new Error("Connection failed after dispatch"), {
		retryable: true,
	});
	await assert.rejects(
		fetchContainerWithRetry({
			namespace: namespace(() => {
				acquisitions += 1;
				return { fetch: async () => Promise.reject(failure) };
			}),
			workspaceId: "workspace",
			operation: "POST /lix/v1/execute",
			envVars: {},
			createRequest: () => new Request("https://container.test/lix/v1/execute"),
			requestReplay: "unsafe",
			retryDelay: async () => undefined,
		}),
		(error: unknown) => error === failure,
	);
	assert.equal(acquisitions, 1);
});

void test("unsafe requests retry only when dispatch proves the container was not ready", async () => {
	let acquisitions = 0;
	const response = await fetchContainerWithRetry({
		namespace: namespace(() => {
			acquisitions += 1;
			return {
				fetch: async () => {
					if (acquisitions === 1) {
						throw new Error("The container is not running");
					}
					return new Response("ok");
				},
			};
		}),
		workspaceId: "workspace",
		operation: "POST /lix/v1/execute",
		envVars: {},
		createRequest: () => new Request("https://container.test/lix/v1/execute"),
		requestReplay: "unsafe",
		retryDelay: async () => undefined,
	});

	assert.equal(await response.text(), "ok");
	assert.equal(acquisitions, 2);
});

void test("generic retryable HTTP statuses are returned without blind replay", async () => {
	let acquisitions = 0;
	const response = await fetchContainerWithRetry({
		namespace: namespace(() => {
			acquisitions += 1;
			return {
				fetch: async () =>
					new Response("Application unavailable", { status: 503 }),
			};
		}),
		workspaceId: "workspace",
		operation: "GET /lix/v1/",
		envVars: {},
		createRequest: () => new Request("https://container.test/lix/v1/"),
		requestReplay: "safe",
		retryDelay: async () => undefined,
	});

	assert.equal(response.status, 503);
	assert.equal(await response.text(), "Application unavailable");
	assert.equal(acquisitions, 1);
});

function namespace(
	getByName: ContainerNamespace["getByName"],
): ContainerNamespace {
	return { getByName };
}
