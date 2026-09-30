import assert from "node:assert/strict";
import test from "node:test";
import {
	parseRepositoryOpenReport,
	captureRepositoryOpenReport,
} from "./repository-open-telemetry.ts";

const id = "11111111-1111-4111-8111-111111111111";
void test("server independently sanitizes browser diagnostics", () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		release: "a".repeat(40),
		diagnostic: {
			lix_error_code: "LIX_ADMISSION_EPOCH",
			httpStatus: 426,
			token: "secret",
			message: "secret",
		},
	});
	assert.deepEqual(report, {
		repositoryId: id,
		release: "a".repeat(40),
		fields: { lix_error_code: "LIX_ADMISSION_EPOCH", httpStatus: 426 },
		frames: [],
	});
	assert.equal(parseRepositoryOpenReport({ repositoryId: "invalid" }), null);
});

void test("server delivers exceptions independently of browser PostHog", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {},
	})!;
	let payload: Record<string, unknown> = {};
	assert.equal(
		await captureRepositoryOpenReport(
			report,
			"actor",
			{
				POSTHOG_PROJECT_TOKEN: "project-token",
				POSTHOG_ENVIRONMENT: "production",
			},
			async (_url, init) => {
				payload = JSON.parse(init?.body as string) as Record<string, unknown>;
				return new Response("{}", { status: 200 });
			},
		),
		true,
	);
	assert.equal(payload.event, "$exception");
	const properties = payload.properties as Record<string, unknown>;
	assert.equal(properties.operation, "repository_open");
	assert.equal(properties.delivery, "first_party");
});

void test("first-party exception values show bounded migration cause and path", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {
			lix_error_code: "LIX_PARTIAL_REPLICA_STATE_INVALID",
			failureReason: "v2_receipt_shape_invalid",
			failurePath: "$.descriptor.descriptorVersion",
			message: "private payload",
		},
	})!;
	let payload: Record<string, unknown> = {};
	await captureRepositoryOpenReport(
		report,
		"actor",
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		async (_url, init) => {
			payload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response("{}", { status: 200 });
		},
	);
	const properties = payload.properties as {
		failureReason: string;
		failurePath: string;
		$exception_list: Array<{ value: string }>;
	};
	assert.equal(properties.failureReason, "v2_receipt_shape_invalid");
	assert.equal(properties.failurePath, "$.descriptor.descriptorVersion");
	assert.equal(
		properties.$exception_list[0]!.value,
		"Repository opening failed: v2_receipt_shape_invalid at $.descriptor.descriptorVersion",
	);
	assert.doesNotMatch(JSON.stringify(payload), /private payload/);
});

void test("first-party exception values show bounded selected-payload diagnosis", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {
			lix_error_code: "LIX_INTERNAL_ERROR",
			payloadFailureReason: "selected_change_payload_unavailable",
			payloadPhysicalStatus: "missing_snapshot",
			changeId: id,
			payload: "private bytes",
		},
	})!;
	let payload: Record<string, unknown> = {};
	await captureRepositoryOpenReport(
		report,
		"actor",
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		async (_url, init) => {
			payload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response("{}", { status: 200 });
		},
	);
	const properties = payload.properties as {
		payloadFailureReason: string;
		payloadPhysicalStatus: string;
		changeId: string;
		$exception_list: Array<{ value: string }>;
	};
	assert.equal(
		properties.payloadFailureReason,
		"selected_change_payload_unavailable",
	);
	assert.equal(properties.payloadPhysicalStatus, "missing_snapshot");
	assert.equal(properties.changeId, id);
	assert.equal(
		properties.$exception_list[0]!.value,
		"Repository opening failed: selected_change_payload_unavailable",
	);
	assert.doesNotMatch(JSON.stringify(payload), /private bytes/);
});

void test("first-party exception values preserve bounded owner point-read counts", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {
			lix_error_code: "LIX_INTERNAL_ERROR",
			payloadFailureReason: "exact_owner_point_read_budget_exhausted",
			attempted: 65_537,
			budget: 65_536,
			privateValue: "secret",
		},
	})!;
	let payload: Record<string, unknown> = {};
	await captureRepositoryOpenReport(
		report,
		"actor",
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		async (_url, init) => {
			payload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response("{}", { status: 200 });
		},
	);
	const properties = payload.properties as {
		payloadFailureReason: string;
		attempted: number;
		budget: number;
		$exception_list: Array<{ value: string }>;
	};
	assert.equal(
		properties.payloadFailureReason,
		"exact_owner_point_read_budget_exhausted",
	);
	assert.equal(properties.attempted, 65_537);
	assert.equal(properties.budget, 65_536);
	assert.equal(
		properties.$exception_list[0]!.value,
		"Repository opening failed: exact_owner_point_read_budget_exhausted",
	);
	assert.doesNotMatch(JSON.stringify(payload), /secret/);
});

void test("first-party exception values preserve fixed pre-request catalog operation", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {
			lix_error_code: "LIX_INTERNAL_ERROR",
			payloadPhase: "pre_request_catalog",
			payloadOperation: "registered_schema_snapshot_load",
			privateValue: "secret schema bytes",
		},
	})!;
	let payload: Record<string, unknown> = {};
	await captureRepositoryOpenReport(
		report,
		"actor",
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		async (_url, init) => {
			payload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response("{}", { status: 200 });
		},
	);
	const properties = payload.properties as Record<string, unknown>;
	assert.equal(properties.payloadPhase, "pre_request_catalog");
	assert.equal(properties.payloadOperation, "registered_schema_snapshot_load");
	assert.doesNotMatch(JSON.stringify(payload), /secret|schema bytes/);
});

void test("diagnostics route authenticates, bounds input and checks repository access", async () => {
	const { handleRequest } = await import("./handler.ts");
	const request = (body: unknown) =>
		new Request("https://lixray.com/api/repository-open-diagnostics", {
			method: "POST",
			headers: { authorization: "Bearer test" },
			body: JSON.stringify(body),
		});
	const env = {
		POSTHOG_PROJECT_TOKEN: "project-token",
		POSTHOG_ENVIRONMENT: "production",
	};
	const body = { repositoryId: id, diagnostic: {} };
	let delivered = 0;
	const options = {
		authenticate: async () => ({
			ok: true as const,
			auth: { userId: "actor", token: "test" },
		}),
		authorizeLix: async () => null,
		fetch: async () => {
			delivered++;
			return new Response("{}");
		},
	};
	assert.equal((await handleRequest(request(body), env, options)).status, 200);
	assert.equal(delivered, 1);
	assert.equal(
		(
			await handleRequest(request(body), env, {
				...options,
				authorizeLix: async () => new Response(null, { status: 403 }),
			})
		).status,
		403,
	);
	assert.equal(
		(
			await handleRequest(
				request({ ...body, extra: "a".repeat(4096) }),
				env,
				options,
			)
		).status,
		413,
	);
	assert.equal(delivered, 1);
});

void test("anonymous reports are accepted only for public repositories", async () => {
	const { handleRequest } = await import("./handler.ts");
	const request = () =>
		new Request("https://lixray.com/api/repository-open-diagnostics", {
			method: "POST",
			body: JSON.stringify({ repositoryId: id, diagnostic: {} }),
		});
	const env = {
		POSTHOG_PROJECT_TOKEN: "project-token",
		POSTHOG_ENVIRONMENT: "production",
	};
	const response = await handleRequest(request(), env, {
		resolvePublicLix: async () => ({ ok: true, lixId: id }),
		fetch: async () => new Response("{}"),
	});
	assert.equal(response.status, 200);
	const denied = await handleRequest(request(), env, {
		resolvePublicLix: async () => ({
			ok: false,
			response: new Response(null, { status: 404 }),
		}),
	});
	assert.equal(denied.status, 404);
});

void test("gateway keeps validated stack frames in PostHog and rejects arbitrary frame data", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {},
		frames: [
			{
				filename: "/assets/app-Abc.js",
				function: "open",
				lineno: 12,
				colno: 34,
				vars: { secret: "private" },
				context_line: "private code",
			},
			{ filename: "https://private.example/document", lineno: 1, colno: 1 },
		],
	})!;
	let payload: Record<string, unknown> = {};
	await captureRepositoryOpenReport(
		report,
		"actor",
		{ POSTHOG_PROJECT_TOKEN: "token", POSTHOG_ENVIRONMENT: "production" },
		async (_url, init) => {
			payload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response("{}");
		},
	);
	const props = payload.properties as {
		$exception_list: Array<{ stacktrace: { type: string; frames: unknown[] } }>;
	};
	assert.equal(props.$exception_list[0]!.stacktrace.type, "raw");
	assert.equal(props.$exception_list[0]!.stacktrace.frames.length, 1);
	assert.doesNotMatch(
		JSON.stringify(payload),
		/private|secret|context_line|vars/,
	);
});
