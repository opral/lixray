import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import {
	MockRemoteLixError,
	openMockRemoteLix,
} from "../lib/mock-remote-lix.ts";
import { findWorkspaceByRoute } from "../lib/workspace-url.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

void test("workspace routes match canonical slugs with case and hyphens normalized", () => {
	const workspace = {
		id: WORKSPACE_ID,
		organizationId: "00000000-0000-4000-8000-000000000001",
		name: "Launch Q3",
		slug: "launch-q3",
		createdAt: "2026-07-12T00:00:00Z",
		updatedAt: "2026-07-12T00:00:00Z",
	};
	const organization = {
		id: workspace.organizationId,
		name: "Acme Corp",
		handle: "acme-corp",
		role: "owner" as const,
		createdAt: "2026-07-12T00:00:00Z",
		updatedAt: "2026-07-12T00:00:00Z",
		workspaces: [workspace],
	};

	assert.deepEqual(
		findWorkspaceByRoute([organization], "ACMECORP", "LaunchQ3"),
		{ organization, workspace },
	);
});

void test("mock remote Lix maps execute params, rows, and explicit values", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		requests.push({ url, init });
		if (url.endsWith("/branches")) {
			return jsonResponse({
				branches: [branch("main-branch", "main")],
			});
		}
		if (url.endsWith("/execute")) {
			return jsonResponse({
				columns: ["nil", "ok", "count", "ratio", "name", "meta", "bytes"],
				rows: [
					[
						{ kind: "null", value: null },
						{ kind: "bool", value: true },
						{ kind: "int", value: 3 },
						{ kind: "float", value: 1.5 },
						{ kind: "text", value: "LixRay" },
						{ kind: "json", value: { ready: true } },
						{ kind: "blob", base64: "AQID" },
					],
				],
				rowsAffected: 1,
				notices: [],
			});
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);

	const result = await lix.execute(
		"SELECT values",
		[null, true, 3, 1.5, "LixRay", { ready: true }, new Uint8Array([1, 2, 3])],
		{ originKey: "atelier-test" },
	);
	const executeRequest = requests.find((request) =>
		request.url.endsWith("/execute"),
	);
	assert.ok(executeRequest?.init?.body);
	assert.deepEqual(parseJsonBody(executeRequest.init.body), {
		branchId: "main-branch",
		sql: "SELECT values",
		params: [
			{ kind: "null", value: null },
			{ kind: "bool", value: true },
			{ kind: "int", value: 3 },
			{ kind: "float", value: 1.5 },
			{ kind: "text", value: "LixRay" },
			{ kind: "json", value: { ready: true } },
			{ kind: "blob", base64: "AQID" },
		],
		options: { originKey: "atelier-test" },
	});
	const row = result.rows[0];
	assert.ok(row);
	assert.equal(row.get("name"), "LixRay");
	assert.deepEqual(row.toObject().meta, { ready: true });
	assert.equal(row.value("count").kind, "integer");
	assert.deepEqual(row.value("bytes").asBytes(), new Uint8Array([1, 2, 3]));

	await lix.close();
});

void test("mock remote Lix parses multiplexed chunked POST-SSE observations", async () => {
	const encoder = new TextEncoder();
	let observeBody: unknown;
	const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url.endsWith("/branches")) {
			return jsonResponse({ branches: [branch("main-branch", "main")] });
		}
		if (url.endsWith("/observe/multiplex")) {
			observeBody = parseJsonBody(init?.body);
			const subscription = firstSubscription(observeBody);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(": keep-alive\r\n\r\nevent: ne"));
						controller.enqueue(
							encoder.encode(
								`xt\r\ndata: ${JSON.stringify(multiplexPayload(subscription.id, "main"))}\r\n\r\n`,
							),
						);
						init?.signal?.addEventListener("abort", () => controller.close());
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);
	const events = lix.observe("SELECT branch");

	const event = await events.next();
	assert.equal(event?.sequence, 1);
	assert.equal(event?.mutationSequence, 2);
	assert.equal(event?.result.rows[0]?.get("branch"), "main");
	assert.deepEqual(observeBody, {
		branchId: "main-branch",
		subscriptions: [{ id: "observe-1", sql: "SELECT branch", params: [] }],
	});

	events.close();
	assert.equal(await events.next(), undefined);
	await lix.close();
});

void test("unexpected SSE closure reconnects the forwarded observation", async () => {
	const encoder = new TextEncoder();
	let observeRequests = 0;
	const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url.endsWith("/branches")) {
			return jsonResponse({ branches: [branch("main-branch", "main")] });
		}
		if (url.endsWith("/observe/multiplex")) {
			observeRequests += 1;
			const subscription = firstSubscription(parseJsonBody(init?.body));
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						if (observeRequests === 1) {
							controller.close();
							return;
						}
						controller.enqueue(
							encoder.encode(
								`event: next\ndata: ${JSON.stringify(multiplexPayload(subscription.id, "reconnected"))}\n\n`,
							),
						);
						init?.signal?.addEventListener("abort", () => controller.close());
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);
	const events = lix.observe("SELECT branch");

	assert.equal(
		(await events.next())?.result.rows[0]?.get("branch"),
		"reconnected",
	);
	assert.equal(observeRequests, 2);

	events.close();
	await lix.close();
});

void test("branch switching restarts live observations and updates later executes", async () => {
	const encoder = new TextEncoder();
	const observedBranches: string[] = [];
	let executeBranch = "";
	const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url.endsWith("/branches")) {
			return jsonResponse({
				branches: [
					branch("main-branch", "main"),
					branch("draft-branch", "Draft"),
				],
			});
		}
		if (url.endsWith("/observe/multiplex")) {
			const body = parseJsonBody(init?.body) as MultiplexRequest;
			const subscription = firstSubscription(body);
			observedBranches.push(body.branchId);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`event: next\ndata: ${JSON.stringify(multiplexPayload(subscription.id, body.branchId))}\n\n`,
							),
						);
						init?.signal?.addEventListener("abort", () => {
							controller.error(new DOMException("Aborted", "AbortError"));
						});
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		if (url.endsWith("/execute")) {
			const body = parseJsonBody(init?.body) as {
				branchId: string;
				sql: string;
			};
			executeBranch = body.branchId;
			return jsonResponse({
				columns: [],
				rows: [],
				rowsAffected: 0,
				notices: [],
			});
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);
	const events = lix.observe("SELECT branch");

	assert.equal(
		await (await events.next())?.result.rows[0]?.get("branch"),
		"main-branch",
	);
	const pendingNext = events.next();
	await lix.switchBranch({ branchId: "draft-branch" });
	const draftEvent = await pendingNext;
	assert.equal(draftEvent?.result.rows[0]?.get("branch"), "draft-branch");
	await lix.execute("SELECT 1");

	assert.deepEqual(observedBranches, ["main-branch", "draft-branch"]);
	assert.equal(executeBranch, "draft-branch");
	events.close();
	await lix.close();
});

void test("many observe queries share one multiplexed stream", async () => {
	const encoder = new TextEncoder();
	let observeRequests = 0;
	const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url.endsWith("/branches")) {
			return jsonResponse({ branches: [branch("main-branch", "main")] });
		}
		if (url.endsWith("/observe/multiplex")) {
			observeRequests += 1;
			const body = parseJsonBody(init?.body) as MultiplexRequest;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const subscription of body.subscriptions) {
							controller.enqueue(
								encoder.encode(
									`event: next\ndata: ${JSON.stringify(multiplexPayload(subscription.id, subscription.sql))}\n\n`,
								),
							);
						}
						init?.signal?.addEventListener("abort", () => controller.close());
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);
	const observers = Array.from({ length: 12 }, (_, index) =>
		lix.observe(`query-${index}`),
	);

	const events = await Promise.all(
		observers.map((observer) => observer.next()),
	);
	assert.equal(observeRequests, 12);
	assert.deepEqual(
		events.map((event) => event?.result.rows[0]?.get("branch")),
		Array.from({ length: 12 }, (_, index) => `query-${index}`),
	);

	for (const observer of observers) observer.close();
	await lix.close();
});

void test("observation network errors racing with close stay non-fatal", async () => {
	let rejectObservation: ((error: unknown) => void) | undefined;
	const observationFailed = new Promise<never>((_resolve, reject) => {
		rejectObservation = reject;
	});
	const fetchMock = (async (input: RequestInfo | URL) => {
		const url = requestUrl(input);
		if (url.endsWith("/branches")) {
			return jsonResponse({ branches: [branch("main-branch", "main")] });
		}
		if (url.endsWith("/observe/multiplex")) {
			await observationFailed;
			throw new Error("unreachable");
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);
	const events = lix.observe("SELECT branch");

	const pendingNext = events.next();
	rejectObservation?.(new TypeError("network error"));
	await Promise.resolve();
	await lix.close();

	assert.equal(await pendingNext, undefined);
});

void test("createBranch switches the mocked client and unsupported operations fail clearly", async () => {
	let createBody: unknown;
	const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url.endsWith("/branches")) {
			return jsonResponse({ branches: [branch("main-branch", "main")] });
		}
		if (url.endsWith("/createBranch")) {
			createBody = parseJsonBody(init?.body);
			return jsonResponse({
				id: "draft-branch",
				name: "Draft",
				hidden: false,
				commitId: "commit-1",
			});
		}
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const lix = await open(fetchMock);

	const created = await lix.createBranch({ name: "Draft" });
	assert.equal(created.id, "draft-branch");
	assert.equal(await lix.activeBranchId(), "draft-branch");
	assert.deepEqual(createBody, { branchId: "main-branch", name: "Draft" });
	await assert.rejects(lix.beginTransaction(), (error: unknown) => {
		return (
			error instanceof MockRemoteLixError &&
			error.code === "LIX_UNSUPPORTED_REMOTE_OPERATION"
		);
	});

	await lix.close();
});

async function open(fetchMock: typeof fetch): Promise<Lix> {
	return openMockRemoteLix({
		workspaceId: WORKSPACE_ID,
		getAccessToken: async () => "test-token",
		fetch: fetchMock,
	});
}

function branch(id: string, name: string) {
	return { id, name, hidden: false, commitId: "commit-0" };
}

function observePayload(branchId: string) {
	return {
		sequence: 1,
		mutationSequence: 2,
		result: {
			columns: ["branch"],
			rows: [[{ kind: "text", value: branchId }]],
			rowsAffected: 0,
			notices: [],
		},
	};
}

type MultiplexRequest = {
	branchId: string;
	subscriptions: Array<{ id: string; sql: string; params: unknown[] }>;
};

function firstSubscription(
	payload: unknown,
): MultiplexRequest["subscriptions"][number] {
	const request = payload as MultiplexRequest;
	const subscription = request.subscriptions[0];
	assert.ok(subscription);
	return subscription;
}

function multiplexPayload(subscriptionId: string, branchId: string) {
	return { subscriptionId, ...observePayload(branchId) };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
	assert.equal(typeof body, "string");
	return JSON.parse(body);
}
