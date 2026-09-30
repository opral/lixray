import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "./otlp-traces.schema.json" with { type: "json" };
import { handleOtlpTelemetry, MAX_OTLP_BYTES } from "./otlp-telemetry.ts";

const env = {
	LIXRAY_INTERNAL_TOKEN: "internal-secret",
	POSTHOG_PROJECT_TOKEN: "project-token",
	POSTHOG_HOST: "https://posthog.example",
	POSTHOG_ENVIRONMENT: "production",
};
interface CaptureBatch {
	api_key: string;
	batch: Array<{
		event: string;
		distinct_id: string;
		timestamp: string;
		uuid: string;
		properties: Record<string, unknown>;
	}>;
}
const codec = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

function span(name = "lix.repository.opened", account = "account-123") {
	return {
		name,
		traceId: Array(16).fill(1),
		spanId: Array(8).fill(2),
		startTimeUnixNano: "1788735600123456789",
		attributes: [
			{ key: "lix.account_id", value: { stringValue: account } },
			{ key: "lix.id", value: { stringValue: "lix-123" } },
			{ key: "lix.branch_id", value: { stringValue: "branch-123" } },
			{ key: "private-field", value: { stringValue: "must-not-project" } },
		],
	};
}
function encode(spans: object[]) {
	return codec
		.encode(
			codec.fromObject({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{ key: "service.name", value: { stringValue: "lix-server" } },
							],
						},
						scopeSpans: [{ spans }],
					},
				],
			}),
		)
		.finish();
}
function request(body: Uint8Array, headers: Record<string, string> = {}) {
	return new Request("https://lixray.com/api/telemetry/otlp/v1/traces", {
		method: "POST",
		body: new Uint8Array(body),
		headers: {
			authorization: `Bearer ${env.LIXRAY_INTERNAL_TOKEN}`,
			"content-type": "application/x-protobuf",
			...headers,
		},
	});
}

void test("standard compressed OTLP is forwarded unchanged and only identified opens are projected", async () => {
	const original = gzipSync(
		encode([
			span(),
			span("lix.sql.query"),
			span("lix.repository.opened", "lixray-demo"),
			span("lix.repository.opened", "00000000-0000-7000-8000-000000000002"),
			span("lix.repository.opened", ""),
		]),
	);
	const calls: Request[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		calls.push(new Request(input, init));
		return new Response(null, { status: 200 });
	};
	const result = await handleOtlpTelemetry(
		request(original, { "content-encoding": "gzip" }),
		env,
		{ fetch: fetcher },
	);
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("content-type"), "application/x-protobuf");
	assert.equal((await result.arrayBuffer()).byteLength, 0);
	assert.equal(calls.length, 2);
	const native = calls.find((call) => call.url.endsWith("/i/v1/traces"))!;
	assert.deepEqual(
		new Uint8Array(await native.arrayBuffer()),
		new Uint8Array(original),
	);
	assert.equal(native.headers.get("authorization"), "Bearer project-token");
	assert.equal(native.headers.get("content-encoding"), "gzip");
	const payload = (await calls
		.find((call) => call.url.endsWith("/batch/"))!
		.json()) as CaptureBatch;
	assert.equal(payload.api_key, "project-token");
	assert.equal(payload.batch.length, 1);
	const event = payload.batch[0];
	assert.equal(event.event, "$ai_span");
	assert.equal(event.distinct_id, "account-123");
	assert.equal(event.timestamp, "2026-09-06T23:00:00.123Z");
	assert.match(
		event.uuid,
		/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.deepEqual(event.properties, {
		$ai_span_name: "lix.repository.opened",
		$ai_trace_id: "01".repeat(16),
		$ai_span_id: "02".repeat(8),
		lix_id: "lix-123",
		branch_id: "branch-123",
		repository_id: "lix-123",
		environment: "production",
		source: "server",
	});
});

void test("partial destination failure is retryable and replay keeps event UUID and timestamp", async () => {
	const body = encode([span()]);
	const events: unknown[] = [];
	let fail = true;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			events.push(((await sent.json()) as CaptureBatch).batch[0]);
		return new Response(null, {
			status: fail && sent.url.endsWith("/i/v1/traces") ? 503 : 200,
		});
	};
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		503,
	);
	fail = false;
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		200,
	);
	assert.equal(events.length, 2);
	assert.deepEqual(events[0], events[1]);
});

void test("SQL-only batches preserve native tracing without product capture", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async (input) => {
		assert.match(new Request(input).url, /\/i\/v1\/traces$/);
		calls++;
		return new Response();
	};
	assert.equal(
		(
			await handleOtlpTelemetry(request(encode([span("lix.sql.query")])), env, {
				fetch: fetcher,
			})
		).status,
		200,
	);
	assert.equal(calls, 1);
});

void test("server error logs become exceptions with diagnostics, correlation and stable replay IDs", async () => {
	const body = encode([
		{
			...span("lix.runtime.open", ""),
			events: [
				{
					name: "Retrying migration",
					attributes: [{ key: "level", value: { stringValue: "WARN" } }],
				},
				{
					name: "Lix repository migration failed",
					timeUnixNano: "1788735601123456789",
					attributes: [
						{ key: "level", value: { stringValue: "ERROR" } },
						{
							key: "error",
							value: {
								stringValue:
									"open authority: certified-authority-v4 is unsupported; Bearer secret-value",
							},
						},
						{ key: "from_version", value: { intValue: 78 } },
						{ key: "to_version", value: { intValue: 79 } },
						{ key: "sql", value: { stringValue: "private SQL" } },
					],
				},
			],
		},
	]);
	const batches: CaptureBatch[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			batches.push((await sent.json()) as CaptureBatch);
		return new Response();
	};
	for (let retry = 0; retry < 2; retry++) {
		assert.equal(
			(await handleOtlpTelemetry(request(body), env, { fetch: fetcher }))
				.status,
			200,
		);
	}
	assert.deepEqual(batches[0], batches[1]);
	assert.equal(batches[0].batch.length, 1);
	const captured = batches[0].batch[0];
	assert.equal(captured.event, "$exception");
	assert.equal(captured.distinct_id, "lix-server:lix-123");
	assert.equal(captured.timestamp, "2026-09-06T23:00:01.123Z");
	assert.deepEqual(captured.properties.$exception_list, [
		{
			type: "LixServerError",
			value:
				"open authority: certified-authority-v4 is unsupported; Bearer [REDACTED]",
			mechanism: { type: "generic", handled: true },
		},
	]);
	assert.equal(
		captured.properties.server_log_message,
		"Lix repository migration failed",
	);
	assert.equal(captured.properties.$otel_trace_id, "01".repeat(16));
	assert.equal(captured.properties.$otel_span_id, "02".repeat(8));
	assert.equal(captured.properties.fromVersion, 78);
	assert.equal(captured.properties.toVersion, 79);
	assert.equal(captured.properties.repository_id, "lix-123");
	assert.doesNotMatch(
		JSON.stringify(captured),
		/secret-value|private SQL|must-not-project/,
	);
});

void test("server parser failures project only the allowlisted cause and receipt path", async () => {
	const body = encode([
		{
			...span("lix.engine.open"),
			status: { code: 2 },
			attributes: [
				...span().attributes,
				{
					key: "error.type",
					value: { stringValue: "LIX_PARTIAL_REPLICA_STATE_INVALID" },
				},
				{
					key: "lix.migration.phase",
					value: { stringValue: "partial_receipt" },
				},
				{
					key: "lix.migration.failure_reason",
					value: { stringValue: "v2_receipt_shape_invalid" },
				},
				{
					key: "lix.migration.failure_path",
					value: { stringValue: "$.descriptor.descriptorVersion" },
				},
				{
					key: "lix.receipt.version",
					value: { intValue: 2 },
				},
				{
					key: "lix.receipt.expected_version",
					value: { intValue: 3 },
				},
			],
			events: [
				{
					name: "partial receipt decode failed",
					attributes: [
						{ key: "level", value: { stringValue: "ERROR" } },
						{
							key: "error",
							value: {
								stringValue: "serde detail includes private receipt data",
							},
						},
					],
				},
			],
		},
	]);
	let batch: CaptureBatch | undefined;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			batch = (await sent.json()) as CaptureBatch;
		return new Response();
	};
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		200,
	);
	const properties = batch!.batch[0]!.properties;
	assert.equal(properties.lix_error_code, "LIX_PARTIAL_REPLICA_STATE_INVALID");
	assert.equal(properties.migrationPhase, "partial_receipt");
	assert.equal(properties.failureReason, "v2_receipt_shape_invalid");
	assert.equal(properties.failurePath, "$.descriptor.descriptorVersion");
	assert.equal(properties.receiptVersion, 2);
	assert.equal(properties.expectedReceiptVersion, 3);
	assert.deepEqual(properties.$exception_list, [
		{
			type: "LIX_PARTIAL_REPLICA_STATE_INVALID",
			value:
				"LIX_PARTIAL_REPLICA_STATE_INVALID: v2_receipt_shape_invalid at $.descriptor.descriptorVersion",
			mechanism: { type: "generic", handled: true },
		},
	]);
	assert.doesNotMatch(JSON.stringify(properties), /private receipt data/);
});

void test("JSON receipt parser positions and missing fields stay bounded in PostHog", async () => {
	const body = encode([
		{
			...span("lix.engine.open"),
			status: { code: 2 },
			attributes: [
				...span().attributes,
				{
					key: "error.type",
					value: { stringValue: "LIX_PARTIAL_REPLICA_STATE_INVALID" },
				},
				{
					key: "lix.migration.phase",
					value: { stringValue: "partial_receipt" },
				},
				{
					key: "lix.migration.failure_reason",
					value: { stringValue: "receipt_json_data" },
				},
				{
					key: "lix.migration.failure_path",
					value: { stringValue: "$" },
				},
				{ key: "lix.migration.json_line", value: { intValue: 12 } },
				{ key: "lix.migration.json_column", value: { intValue: 5 } },
				{ key: "lix.receipt.version", value: { intValue: 3 } },
				{ key: "lix.receipt.expected_version", value: { intValue: 3 } },
				{
					key: "lix.migration.missing_field",
					value: { stringValue: "authorId" },
				},
			],
			events: [
				{
					name: "partial receipt decode failed",
					attributes: [
						{ key: "level", value: { stringValue: "ERROR" } },
						{
							key: "error",
							value: { stringValue: "private receipt parser output" },
						},
					],
				},
			],
		},
	]);
	let batch: CaptureBatch | undefined;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			batch = (await sent.json()) as CaptureBatch;
		return new Response();
	};
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		200,
	);
	const properties = batch!.batch[0]!.properties;
	assert.equal(properties.migrationPhase, "partial_receipt");
	assert.equal(properties.failureReason, "receipt_json_data");
	assert.equal(properties.failurePath, "$");
	assert.equal(properties.jsonLine, 12);
	assert.equal(properties.jsonColumn, 5);
	assert.equal(properties.receiptVersion, 3);
	assert.equal(properties.expectedReceiptVersion, 3);
	assert.equal(properties.missingField, "authorId");
	assert.deepEqual(properties.$exception_list, [
		{
			type: "LIX_PARTIAL_REPLICA_STATE_INVALID",
			value: "LIX_PARTIAL_REPLICA_STATE_INVALID: receipt_json_data at $",
			mechanism: { type: "generic", handled: true },
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(properties),
		/private receipt parser output/,
	);
});

void test("standard OTel exceptions preserve the cause without inventing a stack trace", async () => {
	const body = encode([
		{
			...span("lix.protocol.request"),
			events: [
				{
					name: "exception",
					attributes: [
						{ key: "exception.type", value: { stringValue: "StorageError" } },
						{
							key: "exception.message",
							value: { stringValue: "storage unavailable" },
						},
					],
				},
			],
		},
	]);
	let captured: CaptureBatch | undefined;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			captured = (await sent.json()) as CaptureBatch;
		return new Response();
	};
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		200,
	);
	assert.deepEqual(captured!.batch[0].properties.$exception_list, [
		{
			type: "StorageError",
			value: "storage unavailable",
			mechanism: { type: "generic", handled: true },
		},
	]);
});

void test("auth, malformed protobuf, unsupported formats, and compressed expansion are rejected before export", async () => {
	const fetcher: typeof fetch = async () => {
		assert.fail("must not export");
	};
	for (const [input, status] of [
		[request(new Uint8Array(), { authorization: "Bearer wrong" }), 401],
		[request(new Uint8Array([0xff])), 400],
		[request(new Uint8Array([1]), { "content-encoding": "gzip" }), 400],
		[request(new Uint8Array(), { "content-encoding": "br" }), 415],
		[request(new Uint8Array(), { "content-type": "application/json" }), 415],
		[request(new Uint8Array(MAX_OTLP_BYTES + 1)), 413],
		[
			request(gzipSync(new Uint8Array(MAX_OTLP_BYTES + 1)), {
				"content-encoding": "gzip",
			}),
			413,
		],
	] as const) {
		assert.equal(
			(await handleOtlpTelemetry(input, env, { fetch: fetcher })).status,
			status,
		);
	}
});

void test("unconfigured destination never silently acknowledges trace loss", async () => {
	const fetcher: typeof fetch = async () => {
		assert.fail("must not export");
	};
	assert.equal(
		(
			await handleOtlpTelemetry(
				request(encode([])),
				{ ...env, POSTHOG_PROJECT_TOKEN: undefined },
				{ fetch: fetcher },
			)
		).status,
		503,
	);
	assert.equal(
		(
			await handleOtlpTelemetry(
				request(encode([])),
				{ ...env, POSTHOG_ENVIRONMENT: "preview" },
				{ fetch: fetcher },
			)
		).status,
		503,
	);
});

void test("stalled downstream delivery is aborted within the receiver deadline", async () => {
	let aborted = false;
	const fetcher: typeof fetch = (_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			// Keep the test alive; the production fetch implementation owns the socket.
			const guard = setTimeout(
				() => reject(new Error("deadline was not enforced")),
				6_000,
			);
			init!.signal!.addEventListener(
				"abort",
				() => {
					aborted = true;
					clearTimeout(guard);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		});
	const started = Date.now();
	const result = await handleOtlpTelemetry(
		request(encode([span("lix.sql.query")])),
		env,
		{ fetch: fetcher },
	);
	assert.equal(result.status, 503);
	assert.equal(aborted, true);
	assert.ok(Date.now() - started < 5_000);
});

void test("status-only admission failures reach PostHog with code, versions, HTTP status and correlation", async () => {
	const body = encode([
		{
			...span("lix.protocol.request"),
			status: { code: 2 },
			attributes: [
				{ key: "lix.request.phase", value: { stringValue: "admission" } },
				...span().attributes,
				{
					key: "lix.error.code",
					value: { stringValue: "LIX_ERROR_RECOVERING" },
				},
				{ key: "http.response.status_code", value: { intValue: 503 } },
				{ key: "lix.receipt.version", value: { intValue: 2 } },
				{ key: "lix.receipt.expected_version", value: { intValue: 3 } },
				{ key: "lix.request.id", value: { stringValue: "request-123" } },
			],
		},
	]);
	const batches: CaptureBatch[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			batches.push((await sent.json()) as CaptureBatch);
		return new Response();
	};
	for (let i = 0; i < 2; i++)
		assert.equal(
			(await handleOtlpTelemetry(request(body), env, { fetch: fetcher }))
				.status,
			200,
		);
	assert.deepEqual(batches[0], batches[1]);
	const props = batches[0]!.batch[0]!.properties;
	assert.equal(props.lix_error_code, "LIX_ERROR_RECOVERING");
	assert.equal(props.operation, "lix.protocol.request");
	assert.equal(props.httpStatus, 503);
	assert.equal(props.request_phase, "admission");
	assert.equal(props.receiptVersion, 2);
	assert.equal(props.expectedReceiptVersion, 3);
	assert.equal(props.request_id, "request-123");
	assert.equal(props.$otel_trace_id, "01".repeat(16));
	assert.doesNotMatch(JSON.stringify(props), /must-not-project/);
});

void test("browser status-only engine failures use browser source and preserve resource revision", async () => {
	const bytes = codec
		.encode(
			codec.fromObject({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{
									key: "vcs.ref.head.revision",
									value: { stringValue: "a".repeat(40) },
								},
								{ key: "private-resource", value: { stringValue: "secret" } },
							],
						},
						scopeSpans: [
							{
								spans: [
									{
										...span("lix.engine.open"),
										status: { code: 2 },
										attributes: [
											...span().attributes,
											{
												key: "error.type",
												value: {
													stringValue: "LIX_PARTIAL_REPLICA_STATE_INVALID",
												},
											},
											{
												key: "lix.error.source_code",
												value: {
													stringValue: "LIX_PARTIAL_REPLICA_STATE_INVALID",
												},
											},
											{
												key: "lix.migration.phase",
												value: { stringValue: "partial_receipt" },
											},
											{
												key: "lix.receipt.version",
												value: { intValue: 2 },
											},
											{
												key: "lix.receipt.expected_version",
												value: { intValue: 3 },
											},
											{
												key: "lix.migration.failure_reason",
												value: {
													stringValue: "v2_branch_incarnation_mismatch",
												},
											},
											{
												key: "lix.migration.failure_path",
												value: {
													stringValue: "$.descriptor.selectedBranch.createdAt",
												},
											},
											{
												key: "lix.error.retryable",
												value: { boolValue: false },
											},
											{
												key: "lix.recovery.retry_exhausted",
												value: { boolValue: true },
											},
											{
												key: "lix.recovery.deadline_exceeded",
												value: { boolValue: true },
											},
											{
												key: "lix.payload.standalone_status",
												value: { stringValue: "matched" },
											},
											{
												key: "lix.payload.physical_status",
												value: { stringValue: "missing_snapshot" },
											},
											{
												key: "lix.payload.failure_reason",
												value: {
													stringValue: "selected_change_payload_unavailable",
												},
											},
											{
												key: "lix.payload.phase",
												value: { stringValue: "pre_request_catalog" },
											},
											{
												key: "lix.payload.operation",
												value: {
													stringValue: "registered_schema_identity_scan",
												},
											},
											{
												key: "lix.payload.change_id",
												value: {
													stringValue: "11111111-1111-4111-8111-111111111111",
												},
											},
											{
												key: "lix.payload.source_deferred",
												value: { boolValue: true },
											},
											{
												key: "lix.payload.physical_conflict",
												value: { boolValue: true },
											},
											{
												key: "lix.payload.source_commit_id",
												value: { stringValue: "private-secret" },
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
	let batch: CaptureBatch | undefined;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			batch = (await sent.json()) as CaptureBatch;
		return new Response();
	};
	assert.equal(
		(
			await handleOtlpTelemetry(request(bytes), env, {
				fetch: fetcher,
				authenticatedBrowser: true,
			})
		).status,
		200,
	);
	const props = batch!.batch[0]!.properties;
	assert.equal(props.source, "browser");
	assert.equal(props.$exception_source, "browser");
	assert.equal(props.client_release, "a".repeat(40));
	assert.equal(props.lix_error_code, "LIX_PARTIAL_REPLICA_STATE_INVALID");
	assert.equal(props.sourceCode, "LIX_PARTIAL_REPLICA_STATE_INVALID");
	assert.equal(props.migrationPhase, "partial_receipt");
	assert.equal(props.receiptVersion, 2);
	assert.equal(props.expectedReceiptVersion, 3);
	assert.equal(props.failureReason, "v2_branch_incarnation_mismatch");
	assert.equal(props.failurePath, "$.descriptor.selectedBranch.createdAt");
	assert.equal(
		(props.$exception_list as Array<{ value: string }>)[0]!.value,
		"LIX_PARTIAL_REPLICA_STATE_INVALID: v2_branch_incarnation_mismatch at $.descriptor.selectedBranch.createdAt",
	);
	assert.equal(props.retryable, false);
	assert.equal(props.admissionRetryExhausted, true);
	assert.equal(props.recoveryDeadlineExceeded, true);
	assert.equal(props.payloadStandaloneStatus, "matched");
	assert.equal(props.payloadPhysicalStatus, "missing_snapshot");
	assert.equal(
		props.payloadFailureReason,
		"selected_change_payload_unavailable",
	);
	assert.equal(props.payloadPhase, "pre_request_catalog");
	assert.equal(props.payloadOperation, "registered_schema_identity_scan");
	assert.equal(props.changeId, "11111111-1111-4111-8111-111111111111");
	assert.equal(props.payloadSourceDeferred, true);
	assert.equal(props.payloadPhysicalConflict, true);
	assert.equal(props.sourceCommitId, undefined);
	assert.doesNotMatch(JSON.stringify(props), /secret|must-not-project/);
});

void test("owner point-read budget errors project only their bounded reason and counts", async () => {
	const body = encode([
		{
			...span("lix.repository.open"),
			status: { code: 2 },
			attributes: [
				...span().attributes,
				{
					key: "lix.error.code",
					value: { stringValue: "LIX_INTERNAL_ERROR" },
				},
				{
					key: "lix.payload.failure_reason",
					value: { stringValue: "exact_owner_point_read_budget_exhausted" },
				},
				{ key: "lix.payload.attempted", value: { intValue: 65_537 } },
				{ key: "lix.payload.budget", value: { intValue: 65_536 } },
				{ key: "private.payload", value: { stringValue: "secret bytes" } },
			],
		},
	]);
	let batch: CaptureBatch | undefined;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			batch = (await sent.json()) as CaptureBatch;
		return new Response();
	};
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		200,
	);
	const properties = batch!.batch[0]!.properties;
	assert.equal(
		properties.payloadFailureReason,
		"exact_owner_point_read_budget_exhausted",
	);
	assert.equal(properties.attempted, 65_537);
	assert.equal(properties.budget, 65_536);
	assert.equal(
		(properties.$exception_list as Array<{ value: string }>)[0]!.value,
		"LIX_INTERNAL_ERROR: exact_owner_point_read_budget_exhausted",
	);
	assert.doesNotMatch(JSON.stringify(properties), /secret bytes/);

	const invalid = encode([
		{
			...span("lix.repository.open"),
			status: { code: 2 },
			attributes: [
				...span().attributes,
				{
					key: "lix.payload.failure_reason",
					value: { stringValue: "exact_owner_point_read_budget_exhausted" },
				},
				{ key: "lix.payload.attempted", value: { intValue: 999_999 } },
				{ key: "lix.payload.budget", value: { intValue: 65_536 } },
			],
		},
	]);
	let invalidBatch: CaptureBatch | undefined;
	const invalidFetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			invalidBatch = (await sent.json()) as CaptureBatch;
		return new Response();
	};
	assert.equal(
		(
			await handleOtlpTelemetry(request(invalid), env, {
				fetch: invalidFetcher,
			})
		).status,
		200,
	);
	const invalidProperties = invalidBatch!.batch[0]!.properties;
	assert.equal(
		invalidProperties.payloadFailureReason,
		"exact_owner_point_read_budget_exhausted",
	);
	assert.equal(invalidProperties.attempted, undefined);
	assert.equal(invalidProperties.budget, undefined);
});

void test("delivery failures identify the failed destination without exporting private transport errors", async () => {
	const failures: object[] = [];
	const response = await handleOtlpTelemetry(request(encode([span()])), env, {
		reportDeliveryFailure: (failure) => failures.push(failure),
		fetch: (async (url) => {
			const destination =
				url instanceof Request ? url.url : url instanceof URL ? url.href : url;
			if (destination.endsWith("/i/v1/traces"))
				return new Response("private upstream body", { status: 429 });
			throw new Error("private transport error with secret-token");
		}) as typeof fetch,
	});
	assert.equal(response.status, 503);
	assert.deepEqual(failures, [
		{
			code: "LIX_TELEMETRY_UPSTREAM_REJECTED",
			destination: "traces",
			httpStatus: 429,
			source: "server",
		},
		{
			code: "LIX_TELEMETRY_UPSTREAM_UNAVAILABLE",
			destination: "events",
			source: "server",
		},
	]);
	assert.equal(JSON.stringify(failures).includes("private"), false);
	assert.equal(JSON.stringify(failures).includes("secret-token"), false);
});

void test("browser route attempts become replay-stable performance samples with bounded phase timings", async () => {
	const root = {
		...span("lixray.repository.open"),
		attributes: [
			{ key: "lix.id", value: { stringValue: "repo-id" } },
			{
				key: "lixray.repository.open.outcome",
				value: { stringValue: "usable" },
			},
			{
				key: "lixray.repository.open.entry",
				value: { stringValue: "navigation" },
			},
			{
				key: "lixray.repository.open.visibility",
				value: { stringValue: "foreground" },
			},
			{
				key: "lixray.repository.open.duration_ms",
				value: { doubleValue: 123.5 },
			},
			{ key: "lixray.repository.open.engine_ms", value: { doubleValue: 80.5 } },
			{ key: "lixray.repository.open.paint_ms", value: { intValue: 32 } },
			{ key: "private-url", value: { stringValue: "https://private/?secret" } },
		],
	};
	const bytes = encode([
		root,
		{
			...root,
			attributes: [
				...root.attributes,
				{ key: "lix.id", value: { stringValue: "unrelated-id" } },
			],
		},
	]);
	const batches: CaptureBatch[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		if (req.url.endsWith("/batch/"))
			batches.push((await req.json()) as CaptureBatch);
		return new Response(null, { status: 200 });
	};
	for (let replay = 0; replay < 2; replay++)
		assert.equal(
			(
				await handleOtlpTelemetry(request(bytes), env, {
					fetch: fetcher,
					authenticatedBrowser: true,
					browserRepositoryId: "repo-id",
					browserUserId: "trusted-account",
				})
			).status,
			200,
		);
	assert.equal(batches.length, 2);
	assert.deepEqual(batches[0]!.batch, batches[1]!.batch);
	assert.equal(batches[0]!.batch.length, 1);
	const event = batches[0]!.batch[0]!;
	assert.equal(event.event, "repository_open_performance");
	assert.equal(event.distinct_id, "trusted-account");
	assert.equal(event.properties.duration_ms, 123.5);
	assert.equal(event.properties.engine_ms, 80.5);
	assert.equal(event.properties.paint_ms, 32);
	assert.equal(event.properties.outcome, "usable");
	assert.equal(event.properties.entry, "navigation");
	assert.equal(event.properties.visibility, "foreground");
	assert.equal(event.properties.$otel_trace_id, "01".repeat(16));
	assert.doesNotMatch(JSON.stringify(event), /private|secret|unrelated/);
});
