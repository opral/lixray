import { PRODUCT_EVENTS } from "../lib/telemetry-events.ts";
import protobuf from "protobufjs/light.js";
import schema from "./otlp-traces.schema.json" with { type: "json" };
import {
	serverErrorEvents,
	type OtlpSpan,
	type OtlpAttribute,
} from "./otlp-server-errors.ts";

export interface OtlpTelemetryEnvironment {
	LIXRAY_INTERNAL_TOKEN?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
}

interface TraceRequest {
	resourceSpans?: Array<{
		resource?: { attributes?: OtlpAttribute[] };
		scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
	}>;
}

// Generated from the official trace-service proto, never a custom wire format.
const traceRequestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

const REPOSITORY_OPEN_PHASES = [
	"bootstrap",
	"auth",
	"access",
	"replica",
	"engine",
	"branch",
	"session",
	"atelier",
	"initial_view",
	"paint",
] as const;

const REPOSITORY_OPEN_REPLICA_STATES = [
	"fresh",
	"cached",
	"unknown",
	"remote",
	"reused_session",
	"joined_open",
] as const;

const REPOSITORY_OPEN_PROFILE_PREFIX = "lixray.repository.open.profile.";
const REPOSITORY_OPEN_HOST_PREFIX = "lixray.repository.open.host.";
const REPOSITORY_OPEN_PROFILE_RESOURCE_CATEGORIES = [
	"wasm",
	"first_party_js",
	"api",
	"lix",
	"other",
] as const;
const REPOSITORY_OPEN_PROFILE_DURATION_MAX_MS = 3_600_000;
const REPOSITORY_OPEN_PROFILE_BYTES_MAX = 1_000_000_000_000;
const REPOSITORY_OPEN_PROFILE_COUNT_MAX = 1_000;
const REPOSITORY_OPEN_METRIC_MAX = 86_400_000;

function boundedNumber(
	value: unknown,
	max: number,
	integer = false,
): number | undefined {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > max ||
		(integer && !Number.isInteger(value))
	)
		return undefined;
	return value;
}

function copyOpenNumber(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
	field: string,
	property = field,
	max = REPOSITORY_OPEN_METRIC_MAX,
	integer = false,
): void {
	const value = boundedNumber(
		fields[`lixray.repository.open.${field}`],
		max,
		integer,
	);
	if (value !== undefined) properties[property] = value;
}

function copyOpenEnum(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
	property = field,
): void {
	const value = fields[`lixray.repository.open.${field}`];
	if (typeof value === "string" && allowed.includes(value))
		properties[property] = value;
}

function copyOpenBoolean(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
	field: string,
): void {
	const value = fields[`lixray.repository.open.${field}`];
	if (typeof value === "boolean") properties[field] = value;
}

function copyProfileBoolean(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
	field: string,
): void {
	const value = fields[`${REPOSITORY_OPEN_PROFILE_PREFIX}${field}`];
	if (typeof value === "boolean")
		properties[`profile_${field.replaceAll(".", "_")}`] = value;
}

function copyProfileEnum(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
): void {
	const value = fields[`${REPOSITORY_OPEN_PROFILE_PREFIX}${field}`];
	if (typeof value === "string" && allowed.includes(value))
		properties[`profile_${field.replaceAll(".", "_")}`] = value;
}

function copyProfileNumber(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
	field: string,
	max: number,
	integer = false,
): void {
	const value = boundedNumber(
		fields[`${REPOSITORY_OPEN_PROFILE_PREFIX}${field}`],
		max,
		integer,
	);
	if (value !== undefined)
		properties[`profile_${field.replaceAll(".", "_")}`] = value;
}

function projectRepositoryOpenProfile(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
): void {
	for (const field of [
		"navigation_timing_supported",
		"resource_timing_supported",
		"longtask_supported",
		"interval_valid",
		"page_persisted",
		"resources.truncated",
		"longtask.truncated",
	])
		copyProfileBoolean(properties, fields, field);

	copyProfileEnum(properties, fields, "navigation_type", [
		"navigate",
		"reload",
		"back_forward",
		"prerender",
	]);
	copyProfileEnum(properties, fields, "hardware_concurrency_bucket", [
		"1",
		"2",
		"4",
		"8",
		"16_plus",
	]);
	copyProfileEnum(properties, fields, "device_memory_gb_bucket", [
		"0.5_or_less",
		"1",
		"2",
		"4",
		"8_plus",
	]);
	copyProfileEnum(properties, fields, "network_effective_type", [
		"slow-2g",
		"2g",
		"3g",
		"4g",
	]);
	copyProfileEnum(properties, fields, "browser_family", [
		"chrome",
		"edge",
		"firefox",
		"safari",
		"other",
	]);
	const browserMajor = boundedNumber(
		fields[`${REPOSITORY_OPEN_PROFILE_PREFIX}browser_major`],
		1_000,
		true,
	);
	if (browserMajor !== undefined && browserMajor >= 1)
		properties.profile_browser_major = browserMajor;

	for (const field of ["dns_ms", "connect_ms", "tls_ms", "ttfb_ms"])
		copyProfileNumber(
			properties,
			fields,
			field,
			REPOSITORY_OPEN_PROFILE_DURATION_MAX_MS,
		);
	for (const field of [
		"response_transfer_bytes",
		"response_encoded_bytes",
		"response_decoded_bytes",
	])
		copyProfileNumber(
			properties,
			fields,
			field,
			REPOSITORY_OPEN_PROFILE_BYTES_MAX,
			true,
		);

	for (const field of [
		"longtask.count",
		"longtask.total_ms",
		"longtask.max_ms",
	])
		copyProfileNumber(
			properties,
			fields,
			field,
			field.endsWith(".count")
				? REPOSITORY_OPEN_PROFILE_COUNT_MAX
				: REPOSITORY_OPEN_PROFILE_DURATION_MAX_MS,
			field.endsWith(".count"),
		);

	for (const category of REPOSITORY_OPEN_PROFILE_RESOURCE_CATEGORIES) {
		for (const [measure, max, integer] of [
			["count", REPOSITORY_OPEN_PROFILE_COUNT_MAX, true],
			["duration_ms", REPOSITORY_OPEN_PROFILE_DURATION_MAX_MS, false],
			["transfer_bytes", REPOSITORY_OPEN_PROFILE_BYTES_MAX, true],
		] as const) {
			copyProfileNumber(
				properties,
				fields,
				`resources.${category}.${measure}`,
				max,
				integer,
			);
		}
	}
}

function projectRepositoryOpenHost(
	properties: Record<string, unknown>,
	fields: Record<string, unknown>,
): void {
	if (fields[`${REPOSITORY_OPEN_HOST_PREFIX}version`] === 1)
		properties.host_version = 1;

	const realmReused = fields[`${REPOSITORY_OPEN_HOST_PREFIX}wasm.realm_reused`];
	if (typeof realmReused === "boolean")
		properties.host_wasm_realm_reused = realmReused;

	const enums: readonly (readonly [string, readonly string[]])[] = [
		["wasm.source", ["bundled", "cache", "network", "realm"]],
		[
			"wasm.cache_status",
			["hit", "miss", "corrupt", "unavailable", "not_consulted"],
		],
	] as const;
	for (const [field, allowed] of enums) {
		const value = fields[`${REPOSITORY_OPEN_HOST_PREFIX}${field}`];
		if (typeof value === "string" && allowed.includes(value))
			properties[`host_${field.replaceAll(".", "_")}`] = value;
	}

	for (const field of [
		"wasm.wait_ms",
		"wasm.fetch_ms",
		"wasm.compile_ms",
		"wasm.initialize_ms",
		"component_compiler.import_ms",
		"component_compiler.initialize_ms",
		"provider.module_import_ms",
		"provider.create_ms",
		"provider.open_ms",
		"provider.opfs.lock_wait_ms",
		"provider.opfs.sqlite_init_ms",
		"provider.opfs.pool_open_ms",
		"provider.opfs.schema_init_ms",
		"native_binding_open_ms",
	]) {
		const value = boundedNumber(
			fields[`${REPOSITORY_OPEN_HOST_PREFIX}${field}`],
			REPOSITORY_OPEN_PROFILE_DURATION_MAX_MS,
		);
		if (value !== undefined)
			properties[`host_${field.replaceAll(".", "_")}`] = value;
	}
}

export const MAX_OTLP_BYTES = 4 * 1024 * 1024;
const DELIVERY_TIMEOUT_MS = 4_000;

class InputError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readBounded(
	stream: ReadableStream<Uint8Array> | null,
	signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
	if (!stream) return new Uint8Array();
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_OTLP_BYTES)
				throw new InputError(413, "OTLP payload too large");
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	} finally {
		signal.removeEventListener("abort", cancel);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function openedEvent(span: OtlpSpan) {
	if (span.name !== "lix.repository.opened") return null;
	if (
		span.traceId?.length !== 16 ||
		span.spanId?.length !== 8 ||
		!span.traceId.some(Boolean) ||
		!span.spanId.some(Boolean)
	)
		return null;
	const attributes: Record<string, string> = {};
	for (const { key, value } of span.attributes ?? []) {
		if (key && typeof value?.stringValue === "string")
			attributes[key] = value.stringValue;
	}
	const traceId = hex(span.traceId);
	const spanId = hex(span.spanId);
	const account = attributes["lix.account_id"]?.trim();
	const lixId = attributes["lix.id"]?.trim();
	if (
		!account ||
		!lixId ||
		account === "lixray-demo" ||
		account === "00000000-0000-7000-8000-000000000002"
	)
		return null;
	let timestamp: string;
	try {
		const nanos = BigInt(span.startTimeUnixNano?.toString() ?? "0");
		if (nanos <= 0n) return null;
		timestamp = new Date(Number(nanos / 1_000_000n)).toISOString();
	} catch {
		return null;
	}
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${traceId}:${spanId}`),
		),
	);
	digest[6] = (digest[6]! & 0x0f) | 0x80;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	const id = hex(digest.subarray(0, 16));
	return {
		event: "$ai_span",
		distinct_id: account,
		properties: {
			$ai_span_name: "lix.repository.opened",
			$ai_trace_id: traceId,
			$ai_span_id: spanId,
			lix_id: lixId,
			repository_id: lixId,
			...(attributes["lix.branch_id"]
				? { branch_id: attributes["lix.branch_id"] }
				: {}),
			environment: "production",
			source: "server",
		},
		timestamp,
		uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
	};
}

/** A queryable performance sample for each finished browser route attempt. */
async function repositoryPerformanceEvent(
	span: OtlpSpan,
	repositoryId: string,
	resourceAttributes: OtlpAttribute[] = [],
	userId?: string,
) {
	if (
		span.name !== "lixray.repository.open" ||
		span.traceId?.length !== 16 ||
		span.spanId?.length !== 8 ||
		!span.traceId.some(Boolean) ||
		!span.spanId.some(Boolean)
	)
		return null;
	const fields = Object.fromEntries(
		(span.attributes ?? []).flatMap(({ key, value }) =>
			key && value
				? [
						[
							key,
							Object.hasOwn(value, "stringValue")
								? value.stringValue
								: Object.hasOwn(value, "doubleValue")
									? value.doubleValue
									: Object.hasOwn(value, "intValue")
										? Number(value.intValue?.toString())
										: Object.hasOwn(value, "boolValue")
											? value.boolValue
											: undefined,
						],
					]
				: [],
		),
	);
	if (fields["lix.id"] !== repositoryId) return null;
	const outcome = fields["lixray.repository.open.outcome"];
	const duration = fields["lixray.repository.open.duration_ms"];
	if (
		!["usable", "failed", "cancelled", "superseded", "timeout"].includes(
			String(outcome),
		) ||
		typeof duration !== "number" ||
		!Number.isFinite(duration) ||
		duration < 0 ||
		duration > 86_400_000
	)
		return null;
	let timestamp: string;
	try {
		timestamp = new Date(
			Number(BigInt(span.startTimeUnixNano?.toString() ?? "0") / 1_000_000n),
		).toISOString();
	} catch {
		return null;
	}
	const traceId = hex(span.traceId),
		spanId = hex(span.spanId);
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`repository-performance:${traceId}:${spanId}`),
		),
	);
	digest[6] = (digest[6]! & 0x0f) | 0x80;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	const id = hex(digest.subarray(0, 16));
	const properties: Record<string, unknown> = {
		repository_id: repositoryId,
		lix_id: repositoryId,
		duration_ms: duration,
		outcome,
		surface: "web",
		source: "browser",
		environment: "production",
		$otel_trace_id: traceId,
		$otel_span_id: spanId,
		$process_person_profile: false,
		$geoip_disable: true,
	};
	const revision = resourceAttributes.find(
		({ key }) => key === "service.version",
	)?.value?.stringValue;
	if (revision && /^[a-f0-9]{40}$/.test(revision))
		properties.client_release = revision;
	const visibility = fields["lixray.repository.open.visibility"];
	if (visibility === "foreground" || visibility === "background")
		properties.visibility = visibility;
	const entry = fields["lixray.repository.open.entry"];
	if (["navigation", "client_navigation", "retry"].includes(String(entry)))
		properties.entry = entry;
	if (fields["lixray.repository.open.profile_version"] === 1)
		properties.profile_version = 1;
	copyOpenEnum(
		properties,
		fields,
		"replica_state",
		REPOSITORY_OPEN_REPLICA_STATES,
	);
	copyOpenEnum(properties, fields, "replica_mode", [
		"partial_replica",
		"remote",
	]);
	copyOpenEnum(properties, fields, "session_acquisition", [
		"created",
		"joined",
		"reused",
	]);
	copyOpenBoolean(properties, fields, "initialized_this_open");
	copyOpenNumber(
		properties,
		fields,
		"storage_format",
		"storage_format",
		1_000_000,
		true,
	);
	for (const field of [
		"local_migration_count",
		"authority_migration_count",
		"engine_attempts",
		"retry_count",
		"replacement_count",
		"rpc_count",
		"rpc_response_headers_pending",
		"rpc_failed",
	])
		copyOpenNumber(
			properties,
			fields,
			field,
			field,
			REPOSITORY_OPEN_PROFILE_COUNT_MAX,
			true,
		);
	for (const field of [
		"retry_backoff_scheduled_ms",
		"rpc_response_headers_total_ms",
		"rpc_response_headers_max_ms",
		"longest_phase_ms",
	])
		copyOpenNumber(properties, fields, field);
	copyOpenEnum(properties, fields, "terminal_phase", REPOSITORY_OPEN_PHASES);
	copyOpenEnum(properties, fields, "longest_phase", REPOSITORY_OPEN_PHASES);
	for (const scope of ["local", "authority"] as const) {
		for (const field of ["from_format", "to_format"] as const)
			copyOpenNumber(
				properties,
				fields,
				`native.${scope}.${field}`,
				`native_${scope}_${field}`,
				1_000_000,
				true,
			);
		for (const phase of [
			"inspecting",
			"migrating",
			"validating",
			"opening",
		] as const) {
			copyOpenNumber(
				properties,
				fields,
				`native.${scope}.${phase}_ms`,
				`native_${scope}_${phase}_ms`,
				duration,
			);
		}
	}
	projectRepositoryOpenProfile(properties, fields);
	projectRepositoryOpenHost(properties, fields);
	for (const phase of REPOSITORY_OPEN_PHASES) {
		const value = fields[`lixray.repository.open.${phase}_ms`];
		if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= duration
		)
			properties[`${phase}_ms`] = value;
	}
	return {
		event: PRODUCT_EVENTS.repositoryOpenPerformance,
		distinct_id: userId ?? `browser:${repositoryId}`,
		timestamp,
		uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
		properties,
	};
}

export interface TelemetryDeliveryFailure {
	code:
		| "LIX_TELEMETRY_CONFIGURATION_INVALID"
		| "LIX_TELEMETRY_UPSTREAM_UNAVAILABLE"
		| "LIX_TELEMETRY_UPSTREAM_REJECTED"
		| "LIX_TELEMETRY_DELIVERY_FAILED";
	destination: "gateway" | "traces" | "events";
	source: "browser" | "server";
	httpStatus?: number;
}

/** Lix emits one vendor-neutral OTLP stream; this gateway owns PostHog routing. */
export async function handleOtlpTelemetry(
	request: Request,
	env: OtlpTelemetryEnvironment,
	dependencies: {
		fetch?: typeof fetch;
		authenticatedBrowser?: boolean;
		/** Anonymous browser uploads are limited to the safe repository timing event. */
		publicBrowser?: boolean;
		browserRepositoryId?: string;
		browserUserId?: string;
		reportDeliveryFailure?: (failure: TelemetryDeliveryFailure) => void;
	} = {},
): Promise<Response> {
	if (!dependencies.authenticatedBrowser) {
		if (
			!env.LIXRAY_INTERNAL_TOKEN ||
			request.headers.get("authorization") !==
				`Bearer ${env.LIXRAY_INTERNAL_TOKEN}`
		) {
			return new Response("Unauthorized", { status: 401 });
		}
	}
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim() !==
		"application/x-protobuf"
	) {
		return new Response("Expected OTLP protobuf", { status: 415 });
	}
	const encoding = request.headers.get("content-encoding")?.toLowerCase();
	if (encoding && encoding !== "gzip" && encoding !== "identity")
		return new Response("Unsupported encoding", { status: 415 });
	// When PostHog cannot receive evidence, preserve bounded pipeline health in
	// the host logs. Never log upstream bodies, URLs, tokens or span payloads.
	const reportFailure = (failure: Omit<TelemetryDeliveryFailure, "source">) => {
		try {
			const diagnostic: TelemetryDeliveryFailure = {
				...failure,
				source: dependencies.authenticatedBrowser ? "browser" : "server",
			};
			if (dependencies.reportDeliveryFailure)
				dependencies.reportDeliveryFailure(diagnostic);
			else
				console.error(
					"lix.telemetry.delivery_failed",
					JSON.stringify(diagnostic),
				);
		} catch {
			/* Reporting must not change export acknowledgement/retry semantics. */
		}
	};
	if (!env.POSTHOG_PROJECT_TOKEN || env.POSTHOG_ENVIRONMENT !== "production") {
		reportFailure({
			code: "LIX_TELEMETRY_CONFIGURATION_INVALID",
			destination: "gateway",
		});
		return new Response("Telemetry destination is not configured", {
			status: 503,
		});
	}
	const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
	try {
		const host = new URL(env.POSTHOG_HOST ?? "https://us.i.posthog.com");
		if (!["https:", "http:"].includes(host.protocol)) {
			reportFailure({
				code: "LIX_TELEMETRY_CONFIGURATION_INVALID",
				destination: "gateway",
			});
			return new Response("Invalid telemetry destination", { status: 503 });
		}
		if (Number(request.headers.get("content-length")) > MAX_OTLP_BYTES)
			throw new InputError(413, "OTLP payload too large");
		const original = await readBounded(request.body, signal);
		let decoded: TraceRequest;
		try {
			const bytes =
				encoding === "gzip"
					? await readBounded(
							new Response(original).body!.pipeThrough(
								new DecompressionStream("gzip"),
							),
							signal,
						)
					: original;
			decoded = traceRequestType.decode(bytes) as TraceRequest;
		} catch (error) {
			if (error instanceof InputError || signal.aborted) throw error;
			throw new InputError(400, "Invalid OTLP protobuf");
		}
		const spans =
			decoded.resourceSpans?.flatMap(
				(resource) =>
					resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [],
			) ?? [];
		const opens = dependencies.publicBrowser
			? []
			: (await Promise.all(spans.map(openedEvent))).filter(
					(event) => event !== null,
				);
		const errors = dependencies.publicBrowser
			? []
			: (
					await Promise.all(
						(decoded.resourceSpans ?? []).flatMap((resource) =>
							(resource.scopeSpans ?? []).flatMap((scope) =>
								(scope.spans ?? []).map((span) =>
									serverErrorEvents(span, {
										source: dependencies.authenticatedBrowser
											? "browser"
											: "server",
										resourceAttributes: resource.resource?.attributes,
										browserUserId: dependencies.authenticatedBrowser
											? dependencies.browserUserId
											: undefined,
									}),
								),
							),
						),
					)
				).flat();
		const performanceEvents =
			dependencies.authenticatedBrowser && dependencies.browserRepositoryId
				? (
						await Promise.all(
							(decoded.resourceSpans ?? []).flatMap((resource) =>
								(resource.scopeSpans ?? []).flatMap((scope) =>
									(scope.spans ?? []).map((span) =>
										repositoryPerformanceEvent(
											span,
											dependencies.browserRepositoryId!,
											resource.resource?.attributes,
											dependencies.browserUserId,
										),
									),
								),
							),
						)
					).filter((event) => event !== null)
				: [];
		const events = [...opens, ...errors, ...performanceEvents];
		const fetcher = dependencies.fetch ?? fetch;
		const deliveries = dependencies.publicBrowser
			? []
			: [
					fetcher(new URL("/i/v1/traces", host), {
						method: "POST",
						headers: {
							"content-type": "application/x-protobuf",
							authorization: `Bearer ${env.POSTHOG_PROJECT_TOKEN}`,
							...(encoding ? { "content-encoding": encoding } : {}),
						},
						body: original,
						signal,
					}),
				];
		if (events.length)
			deliveries.push(
				fetcher(new URL("/batch/", host), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						api_key: env.POSTHOG_PROJECT_TOKEN,
						batch: events,
					}),
					signal,
				}),
			);
		const results = await Promise.allSettled(deliveries);
		let delivered = true;
		for (const [index, result] of results.entries()) {
			const destination = index === 0 ? "traces" : "events";
			if (result.status === "rejected") {
				reportFailure({
					code: "LIX_TELEMETRY_UPSTREAM_UNAVAILABLE",
					destination,
				});
				delivered = false;
				continue;
			}
			if (!result.value.ok)
				reportFailure({
					code: "LIX_TELEMETRY_UPSTREAM_REJECTED",
					destination,
					httpStatus: result.value.status,
				});
			delivered &&= result.value.ok;
			void result.value.body?.cancel().catch(() => {});
		}
		if (!delivered)
			return new Response("Telemetry delivery failed", { status: 503 });
		// Empty ExportTraceServiceResponse is valid protobuf success.
		return new Response(new Uint8Array(), {
			headers: { "content-type": "application/x-protobuf" },
		});
	} catch (error) {
		if (!(error instanceof InputError))
			reportFailure({
				code: "LIX_TELEMETRY_DELIVERY_FAILED",
				destination: "gateway",
			});
		return new Response(
			error instanceof InputError ? error.message : "Telemetry delivery failed",
			{
				status: error instanceof InputError ? error.status : 503,
			},
		);
	}
}
