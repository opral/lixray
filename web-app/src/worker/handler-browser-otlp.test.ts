import assert from "node:assert/strict";
import test from "node:test";
import protobuf from "protobufjs/light.js";
import { handleRequest } from "./handler.ts";
import schema from "./otlp-traces.schema.json" with { type: "json" };

const endpoint = "https://lixray.com/api/telemetry/browser/otlp/v1/traces";
const repositoryId = "01920000-0000-7000-8000-000000000001";
const codec = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

function performanceRequest() {
	return codec
		.encode(
			codec.fromObject({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{
									key: "service.version",
									value: { stringValue: "a".repeat(40) },
								},
							],
						},
						scopeSpans: [
							{
								spans: [
									{
										traceId: new Uint8Array(16).fill(1),
										spanId: new Uint8Array(8).fill(2),
										name: "lixray.repository.open",
										startTimeUnixNano: "1788735600123456789",
										attributes: [
											{ key: "lix.id", value: { stringValue: repositoryId } },
											{
												key: "lixray.repository.open.outcome",
												value: { stringValue: "usable" },
											},
											{
												key: "lixray.repository.open.duration_ms",
												value: { doubleValue: 120 },
											},
											{
												key: "private.payload",
												value: { stringValue: "must-not-forward" },
											},
										],
									},
									{
										traceId: new Uint8Array(16).fill(3),
										spanId: new Uint8Array(8).fill(4),
										name: "lix.engine.open",
										startTimeUnixNano: "1788735600123456789",
										status: { code: 2 },
										attributes: [
											{ key: "lix.id", value: { stringValue: "private-repo" } },
											{
												key: "lix.account_id",
												value: { stringValue: "victim" },
											},
											{
												key: "error.type",
												value: { stringValue: "LIX_PRIVATE_FAILURE" },
											},
										],
										events: [
											{
												name: "exception",
												attributes: [
													{
														key: "exception.message",
														value: { stringValue: "must-not-forward-error" },
													},
												],
											},
										],
									},
								],
							},
						],
					},
				],
			}),
		)
		.finish();
}

void test("browser OTLP route requires repository scope and authenticates member uploads", async () => {
	const noActiveRepository = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			body: new Uint8Array(),
		}),
		{},
	);
	assert.equal(noActiveRepository.status, 204);

	const unauthorized = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer bad-token",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(),
		}),
		{},
		{
			authenticate: async () => ({
				ok: false,
				response: new Response("Unauthorized", { status: 401 }),
			}),
			fetch: async () => {
				assert.fail("unauthenticated telemetry must not reach PostHog");
			},
		},
	);
	assert.equal(unauthorized.status, 401);
});

void test("browser OTLP route authorizes the repository and forwards standard OTLP", async () => {
	const calls: Array<{ url: URL; authorization: string | null }> = [];
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer user-token",
				"content-type": "application/x-protobuf",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(),
		}),
		{
			POSTHOG_PROJECT_TOKEN: "phc_project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: "account-1", token: "user-token" },
			}),
			authorizeLix: async (id) => {
				assert.equal(id, repositoryId);
				return null;
			},
			fetch: async (input, init) => {
				calls.push({
					url: new URL(input instanceof Request ? input.url : input.toString()),
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return new Response(new Uint8Array(), { status: 200 });
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url.pathname, "/i/v1/traces");
	assert.equal(calls[0]?.authorization, "Bearer phc_project-token");
});

void test("browser OTLP route rejects repository access before forwarding", async () => {
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer user-token",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(),
		}),
		{},
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: "account-1", token: "user-token" },
			}),
			authorizeLix: async () => new Response("Forbidden", { status: 403 }),
			fetch: async () => {
				assert.fail("unauthorized repository telemetry must not reach PostHog");
			},
		},
	);
	assert.equal(response.status, 403);
});

void test("public browser OTLP accepts only resolver-confirmed repository timing", async () => {
	const calls: Array<{ path: string; body: string }> = [];
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/x-protobuf",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(performanceRequest()),
		}),
		{
			POSTHOG_PROJECT_TOKEN: "phc_project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{
			authenticate: async () => {
				assert.fail("public repository timing must use public resolution");
			},
			resolvePublicLix: async (id) => {
				assert.equal(id, repositoryId);
				return { ok: true, lixId: repositoryId, scope: "repository" };
			},
			authorizeLix: async () => {
				assert.fail(
					"anonymous telemetry must not fabricate a member principal",
				);
			},
			fetch: async (input, init) => {
				const body = init?.body;
				calls.push({
					path: new URL(input instanceof Request ? input.url : input.toString())
						.pathname,
					body: typeof body === "string" ? body : "",
				});
				return new Response("{}", { status: 200 });
			},
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual(
		calls.map((call) => call.path),
		["/batch/"],
	);
	assert.doesNotMatch(
		calls[0]!.body,
		/must-not-forward|private-repo|victim|LIX_PRIVATE_FAILURE/,
	);
	const payload = JSON.parse(calls[0]!.body) as {
		batch: Array<{
			event: string;
			distinct_id: string;
			properties: Record<string, unknown>;
		}>;
	};
	assert.equal(payload.batch.length, 1);
	assert.equal(payload.batch[0]?.event, "repository_open_performance");
	assert.equal(
		payload.batch[0]?.distinct_id,
		"00000000-0000-7000-8000-000000000002",
	);
	assert.equal(payload.batch[0]?.properties.repository_id, repositoryId);
	assert.equal(payload.batch[0]?.properties.duration_ms, 120);
});

void test("public browser OTLP refuses private repositories before reading PostHog", async () => {
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: { "x-lixray-repository-id": repositoryId },
			body: new Uint8Array(),
		}),
		{
			POSTHOG_PROJECT_TOKEN: "phc_project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{
			authenticate: async () => {
				assert.fail("private anonymous access must not authenticate a user");
			},
			resolvePublicLix: async () => ({
				ok: false,
				response: new Response("Not found", { status: 404 }),
			}),
			fetch: async () => {
				assert.fail("private telemetry must not reach PostHog");
			},
		},
	);
	assert.equal(response.status, 404);
});
