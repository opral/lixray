import {
	repositoryOpenDiagnostics,
	repositoryOpenFailureMessage,
} from "../lib/repository-open-telemetry.ts";
import {
	applicationExceptionFrames,
	safeLixErrorCode,
	safeRustErrorOrigin,
} from "../lib/exception-stack-trace.ts";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_EXCEPTION_TYPES = new Set([
	"AggregateError",
	"DOMException",
	"Error",
	"EvalError",
	"LixBrowserError",
	"LixOperationError",
	"LixServerError",
	"RangeError",
	"ReferenceError",
	"RepositorySnapshotDownloadError",
	"SyntaxError",
	"TypeError",
	"URIError",
]);
const EXCEPTION_CLASS =
	/^(?:[a-z][A-Za-z0-9_]{0,63}(?:::|\.)+)*[A-Z][A-Za-z0-9_]{0,63}$/;

/** Project operation diagnostics at the authenticated gateway, never in HTTP errors. */
export interface OtlpAttribute {
	key?: string;
	value?: {
		stringValue?: string;
		boolValue?: boolean;
		doubleValue?: number;
		intValue?: { toString(): string } | number;
	};
}

interface OtlpEvent {
	name?: string;
	timeUnixNano?: { toString(): string };
	attributes?: OtlpAttribute[];
}

export interface OtlpSpan {
	name?: string;
	traceId?: Uint8Array;
	spanId?: Uint8Array;
	parentSpanId?: Uint8Array;
	startTimeUnixNano?: { toString(): string };
	status?: { code?: number };
	attributes?: OtlpAttribute[];
	events?: OtlpEvent[];
}

function attributes(entries: OtlpAttribute[] = []): Record<string, string> {
	return Object.fromEntries(
		entries.flatMap(({ key, value }) => {
			// protobufjs exposes unset oneof defaults on the prototype.
			const text =
				value && Object.hasOwn(value, "stringValue")
					? value.stringValue
					: value && Object.hasOwn(value, "doubleValue")
						? value.doubleValue?.toString()
						: value && Object.hasOwn(value, "intValue")
							? value.intValue?.toString()
							: value && Object.hasOwn(value, "boolValue")
								? value.boolValue?.toString()
								: undefined;
			return key && text !== undefined ? [[key, text]] : [];
		}),
	);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** Keep only short, printable identifiers suitable for correlation metadata. */
function boundedId(value: string | undefined): string | undefined {
	return value &&
		value.length <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
		? value
		: undefined;
}

function safeUuid(value: string | undefined): string | undefined {
	return value && UUID.test(value) ? value.toLowerCase() : undefined;
}

/** Exception types are class labels, never free-form diagnostics. */
function safeExceptionType(
	value: string | undefined,
	fallback: string,
): string {
	if (
		value &&
		value.length <= 128 &&
		(FIXED_EXCEPTION_TYPES.has(value) || EXCEPTION_CLASS.test(value))
	)
		return value;
	return fallback;
}

function safeRustOriginCauseIndex(
	value: string | undefined,
): number | undefined {
	if (value === undefined || !/^[0-3]$/.test(value)) return undefined;
	return Number(value);
}

function safeOperation(value: string | undefined): string {
	if (!value || value.length > 128) return "unknown";
	if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)) return value;
	// Native spans use these fixed display names as `otel.name`. Normalize the
	// protocol names and retain known SQL summaries without accepting free text.
	switch (value) {
		case "Lix protocol request":
			return "lix.protocol.request";
		case "Lix repository admission":
			return "lix.repository.admission";
		case "BATCH SELECT":
		case "BATCH UPDATE":
			return value;
		default:
			return "unknown";
	}
}

function safeServiceName(value: string | undefined): string | undefined {
	return value &&
		value.length <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
		? value
		: undefined;
}

function safeHttpMethod(value: string | undefined): string | undefined {
	return value &&
		[
			"GET",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"HEAD",
			"OPTIONS",
			"CONNECT",
			"TRACE",
		].includes(value)
		? value
		: undefined;
}

/**
 * Accept only a bounded path-shaped route template. Raw targets and query
 * strings are intentionally ignored; route attributes must use `{parameter}`
 * segments for dynamic values.
 */
function safeHttpRoute(value: string | undefined): string | undefined {
	if (
		!value ||
		value.length > 256 ||
		!value.startsWith("/") ||
		!value.includes("{")
	)
		return undefined;
	const segment = "(?:[a-z0-9_-]{1,31}|\\{\\*?[a-z][a-z0-9_]{0,31}\\})";
	return new RegExp(`^/${segment}(?:/${segment})*$`).test(value)
		? value
		: undefined;
}

function safeHttpStatus(value: string | undefined): number | undefined {
	return value && /^[1-5][0-9]{2}$/.test(value) ? Number(value) : undefined;
}

/** Bound diagnostic messages and omit common content-bearing payload forms. */
function diagnostic(value: string): string {
	let sanitized = value
		// ANSI styling is useful in Railway's console, not in captured exceptions.
		// eslint-disable-next-line no-control-regex
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
		.replace(/\bBasic\s+[A-Za-z0-9+/]+=*/gi, "Basic [REDACTED]")
		.replace(
			/\b((?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*)[^\s,;"']+/gi,
			"$1[REDACTED]",
		)
		.replace(/\blixray_pat_[A-Za-z0-9_-]+\b/gi, "[REDACTED_TOKEN]")
		.replace(
			/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
			"[REDACTED_TOKEN]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(
			/\/(?:Users|Volumes|private|tmp|var|home|root)\/[^\s)"'<>[\]{}]+/g,
			"[REDACTED_PATH]",
		)
		.replace(/[A-Za-z]:\\[^\s)"'<>[\]{}]+/g, "[REDACTED_PATH]")
		.replace(
			/([?&](?:[^=\s&]*(?:token|secret|password|signature|credential|key)[^=\s&]*)=)[^\s&#"']*/gi,
			"$1[REDACTED]",
		)
		.replace(
			/\/@[^/\s]+\/[^/\s]+\/file(?:\/[^\s)"'<>]*)?/g,
			"/repository/:repository/file/:file",
		)
		.replace(/\/@[^/\s]+\/[^/\s?#)]+/g, "/repository/:repository")
		.replace(
			/\/lix\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/snapshot/gi,
			"/lix/v1/{lix_id}/snapshot",
		);
	const sql =
		/\b(?:WITH\b[\s\S]*?\bSELECT\b[\s\S]*?\bFROM\b|SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|SCHEMA)\b)/i.exec(
			sanitized,
		);
	if (sql?.index !== undefined)
		sanitized = `${sanitized.slice(0, sql.index)}[SQL statement omitted]`;
	const responseBody = /(?:response\s+(?:body|text)|http\s+body)\s*[:=]/i.exec(
		sanitized,
	);
	if (responseBody?.index !== undefined)
		sanitized = `${sanitized.slice(0, responseBody.index)}[response body omitted]`;
	const htmlBody = /<!doctype\s+html|<html\b|<body\b/i.exec(sanitized);
	if (htmlBody?.index !== undefined)
		sanitized = `${sanitized.slice(0, htmlBody.index)}[response body omitted]`;
	if (
		sanitized.trimStart().startsWith("{") ||
		sanitized.trimStart().startsWith("[")
	) {
		try {
			const parsed: unknown = JSON.parse(sanitized);
			if (parsed && typeof parsed === "object")
				sanitized = "[structured response body omitted]";
		} catch {
			// Keep ordinary diagnostics that happen to start with a brace.
		}
	}
	return sanitized.slice(0, 16_384);
}

export async function serverErrorEvents(
	span: OtlpSpan,
	options: {
		source?: "server" | "browser";
		resourceAttributes?: OtlpAttribute[];
		/** Verified by the authenticated browser route; span identity is untrusted. */
		browserUserId?: string;
	} = {},
) {
	if (
		span.traceId?.length !== 16 ||
		span.spanId?.length !== 8 ||
		!span.traceId.some(Boolean) ||
		!span.spanId.some(Boolean)
	)
		return [];
	const traceId = hex(span.traceId);
	const spanId = hex(span.spanId);
	const context = attributes(span.attributes);
	// Ownership is explicit and travels with each span, even across export batches.
	// A diagnostic child remains available in OTLP but is not another exception.
	if (context["lix.error.owner"] === "diagnostic") return [];
	const resource = attributes(options.resourceAttributes);
	const source = options.source ?? "server";
	const operation = safeOperation(span.name);
	const errorId = safeUuid(context["exception.capture_id"]);
	const serviceName =
		safeServiceName(resource["service.name"]) ??
		(source === "server" ? "lix-server" : "lix-browser");
	const parentSpanId =
		span.parentSpanId?.length === 8 && span.parentSpanId.some(Boolean)
			? hex(span.parentSpanId)
			: undefined;
	const httpMethod = safeHttpMethod(
		context["http.request.method"] ?? context["http.method"],
	);
	const httpRoute = safeHttpRoute(context["http.route"]);
	const httpStatus = safeHttpStatus(context["http.response.status_code"]);
	const candidateCode = context["lix.error.code"] ?? context["error.type"];
	const failureCode = safeLixErrorCode(candidateCode);
	const migrationCause = repositoryOpenDiagnostics({
		details: {
			failureReason: context["lix.migration.failure_reason"],
			failurePath: context["lix.migration.failure_path"],
			payloadFailureReason: context["lix.payload.failure_reason"],
		},
	});
	const snapshot = snapshotReproductionContext(span.name, context);
	const snapshotStage =
		typeof snapshot.failure_stage === "string"
			? snapshot.failure_stage
			: undefined;
	const snapshotStatus = httpStatus?.toString();
	const snapshotMessage = snapshotStage
		? `Remote snapshot download failed (${snapshotStage}${snapshotStatus ? `, HTTP ${snapshotStatus}` : ""})`
		: undefined;
	const events = [...(span.events ?? [])];
	const hasErrorEvent = events.some((event) => {
		const fields = attributes(event.attributes);
		return fields.level === "ERROR" || event.name === "exception";
	});
	// Engine and HTTP failures use standard ERROR status without logging an
	// exception event. Preserve these failures rather than silently dropping them.
	if (!hasErrorEvent && span.status?.code === 2) {
		events.push({
			name: "exception",
			timeUnixNano: span.startTimeUnixNano,
			attributes: [
				{
					key: "exception.type",
					value: {
						stringValue: snapshotMessage
							? "RepositorySnapshotDownloadError"
							: (failureCode ?? "LixOperationError"),
					},
				},
				{
					key: "exception.message",
					value: {
						stringValue:
							snapshotMessage ??
							repositoryOpenFailureMessage(
								{ details: migrationCause },
								failureCode ?? "Lix operation failed",
							),
					},
				},
			],
		});
	}
	if (context["lix.error.owner"] === "boundary") {
		const failure = events.find((event) => {
			const fields = attributes(event.attributes);
			return fields.level === "ERROR" || event.name === "exception";
		});
		events.splice(0, events.length, ...(failure ? [failure] : []));
	}
	const details: Record<string, unknown> = {};
	for (const [key, field] of [
		["lix.error.source_code", "sourceCode"],
		["lix.migration.phase", "migrationPhase"],
		["lix.open.operation_id", "openOperationId"],
		["lix.open.phase", "openPhase"],
		["lix.open.failed_phase", "openFailurePhase"],
		["lix.open.dependency", "openDependency"],
		["lix.open.elapsed_ms", "openElapsedMs"],
		["lix.open.idle_ms", "openIdleMs"],
		["lix.open.rows", "openRows"],
		["lix.open.bytes", "openBytes"],
		["lix.open.completed_groups", "openCompletedGroups"],
		["lix.open.from_format", "fromVersion"],
		["lix.open.to_format", "toVersion"],
		["lix.migration.from_version", "fromVersion"],
		["lix.migration.to_version", "toVersion"],
		["lix.migration.failure_reason", "failureReason"],
		["lix.migration.failure_path", "failurePath"],
		["lix.migration.json_line", "jsonLine"],
		["lix.migration.json_column", "jsonColumn"],
		["lix.migration.missing_field", "missingField"],
		["lix.receipt.version", "receiptVersion"],
		["lix.receipt.expected_version", "expectedReceiptVersion"],
		["lix.recovery.attempts", "recoveryAttempts"],
		["lix.recovery.stage", "recoveryStage"],
		["lix.payload.standalone_status", "payloadStandaloneStatus"],
		["lix.payload.physical_status", "payloadPhysicalStatus"],
		["lix.payload.failure_reason", "payloadFailureReason"],
		["lix.payload.phase", "payloadPhase"],
		["lix.payload.operation", "payloadOperation"],
		["lix.payload.schema_kind", "payloadSchemaKind"],
		["lix.payload.recipe_count", "payloadRecipeCount"],
		["lix.payload.recipe_mask", "payloadRecipeMask"],
		["lix.payload.required_input_count", "payloadRequiredInputCount"],
		["lix.read.recipe_count", "nativeReadRecipeCount"],
		["lix.read.recipe_mask", "nativeReadRecipeMask"],
		["lix.wasm_asset.phase", "phase"],
		["lix.wasm_asset.cache_status", "cacheStatus"],
		["lix.payload.attempted", "attempted"],
		["lix.payload.budget", "budget"],
		["lix.payload.change_id", "changeId"],
		["lix.payload.source_commit_id", "sourceCommitId"],
	])
		if (context[key!] !== undefined) details[field!] = context[key!];
	if (httpStatus !== undefined) details.httpStatus = httpStatus;
	for (const [key, field] of [
		["lix.open.opener_retained", "openerRetained"],
		["lix.open.request_deadline_exceeded", "requestDeadlineExceeded"],
		["lix.error.retryable", "retryable"],
		["lix.recovery.retry_exhausted", "admissionRetryExhausted"],
		["lix.recovery.deadline_exceeded", "recoveryDeadlineExceeded"],
		["lix.payload.source_deferred", "payloadSourceDeferred"],
		["lix.payload.physical_conflict", "payloadPhysicalConflict"],
	]) {
		if (context[key!] === "true" || context[key!] === "false")
			details[field!] = context[key!] === "true";
	}
	// Both first-party failures and OTLP projections use one bounded schema,
	// including canonical number/boolean types for querying in PostHog.
	const structural = repositoryOpenDiagnostics({ code: failureCode, details });
	const structuredFailureMessage =
		typeof migrationCause.failureReason === "string" ||
		typeof migrationCause.payloadFailureReason === "string"
			? repositoryOpenFailureMessage(
					{ details: migrationCause },
					failureCode ?? "Lix operation failed",
				)
			: undefined;
	const outcome = context["lix.commit.outcome"];
	if (outcome && ["not_committed", "committed", "unknown"].includes(outcome))
		structural.commit_outcome = outcome;
	const executionPhase = context["lix.execution.phase"];
	if (executionPhase === "binding") structural.execution_phase = executionPhase;
	const phase = context["lix.request.phase"];
	if (
		phase &&
		["admission", "completed", "protocol_handler", "sql_execution"].includes(
			phase,
		)
	)
		structural.request_phase = phase;
	const revision =
		resource["vcs.ref.head.revision"] ?? resource["service.version"];
	if (revision && /^[a-f0-9]{40}$/.test(revision))
		structural[source === "server" ? "server_release" : "client_release"] =
			revision;
	return (
		await Promise.all(
			events.map(async (event, index) => {
				const fields = attributes(event.attributes);
				// Ignore informational events; the fallback above captures failed status.
				if (fields.level !== "ERROR" && event.name !== "exception") return null;
				let timestamp: string;
				try {
					const eventNanos = BigInt(event.timeUnixNano?.toString() ?? "0");
					const nanos =
						eventNanos > 0n
							? eventNanos
							: BigInt(span.startTimeUnixNano?.toString() ?? "0");
					if (nanos <= 0n) return null;
					timestamp = new Date(Number(nanos / 1_000_000n)).toISOString();
				} catch {
					return null;
				}
				const lixId = boundedId(
					fields.lix_id ?? context["lix.id"] ?? context["lix.lix.id"],
				);
				const account =
					source === "browser"
						? safeUuid(options.browserUserId)
						: context["lix.account_id"];
				const suppliedType = safeExceptionType(
					fields["exception.type"],
					failureCode ??
						(source === "server" ? "LixServerError" : "LixBrowserError"),
				);
				const eventCode = safeLixErrorCode(
					fields["lix.error.code"] ??
						fields["exception.code"] ??
						fields["exception.type"] ??
						context["lix.error.code"] ??
						context["error.type"],
				);
				const nativeError =
					suppliedType === "LixError" ||
					safeLixErrorCode(suppliedType) !== undefined ||
					eventCode !== undefined;
				const type =
					suppliedType === "LixError"
						? (eventCode ?? failureCode ?? suppliedType)
						: suppliedType;
				const message = nativeError
					? (eventCode ?? failureCode ?? type)
					: (structuredFailureMessage ??
						fields["exception.message"] ??
						fields.error ??
						fields.message ??
						event.name);
				if (!message) return null;
				const value = diagnostic(message);
				const summary = nativeError
					? value
					: diagnostic(fields.message ?? event.name ?? "Server error");
				const rustOriginKind =
					fields["exception.rust_origin.kind"] ?? context["rust_origin.kind"];
				const rustOrigin =
					rustOriginKind === "source_location"
						? safeRustErrorOrigin({
								rustOrigin: {
									kind: "source_location",
									file:
										fields["exception.rust_origin.file"] ??
										context["code.filepath"],
									line: Number(
										fields["exception.rust_origin.line"] ??
											context["code.lineno"],
									),
									column: Number(
										fields["exception.rust_origin.column"] ??
											context["code.column"],
									),
								},
							})
						: undefined;
				const rustStacktraceStatus =
					fields["exception.rust_stacktrace_status"] ??
					context["rust_stacktrace_status"];
				const rustOriginCauseIndex = safeRustOriginCauseIndex(
					fields["exception.rust_origin.cause_index"] ??
						context["rust_origin_cause_index"],
				);
				const digest = new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(
							`server-error:${traceId}:${spanId}:${index}`,
						),
					),
				);
				digest[6] = (digest[6]! & 0x0f) | 0x80;
				digest[8] = (digest[8]! & 0x3f) | 0x80;
				const id = hex(digest.subarray(0, 16));
				const eventId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
				return {
					event: "$exception",
					distinct_id: account || `lix-${source}:${lixId ?? "system"}`,
					uuid: eventId,
					timestamp,
					properties: {
						$exception_list: exceptionList(fields, type, value, nativeError),
						$exception_level: "error",
						$exception_source: source,
						$process_person_profile: false,
						$geoip_disable: true,
						$otel_trace_id: traceId,
						$otel_span_id: spanId,
						...(parentSpanId ? { $otel_parent_span_id: parentSpanId } : {}),
						$ai_trace_id: traceId,
						$ai_span_id: spanId,
						environment: "production",
						source,
						service: source === "server" ? "lix-server" : "lix-browser",
						service_name: serviceName,
						...structural,
						...repositoryOpenDiagnostics({
							details: {
								fromVersion: fields.from_version,
								toVersion: fields.to_version,
							},
						}),
						operation,
						error_id: errorId ?? eventId,
						...(httpMethod ? { http_method: httpMethod } : {}),
						...(httpRoute ? { http_route: httpRoute } : {}),
						...(rustOrigin ? { rust_origin: rustOrigin } : {}),
						...(rustOriginCauseIndex !== undefined
							? { rust_origin_cause_index: rustOriginCauseIndex }
							: {}),
						...(rustStacktraceStatus === "not_captured"
							? { rust_stacktrace_status: rustStacktraceStatus }
							: {}),
						...snapshot,
						server_span_name: operation,
						server_log_message: summary,
						server_error_detail: value,
						...(lixId ? { lix_id: lixId, repository_id: lixId } : {}),
						...(boundedId(context["lix.request.id"])
							? { request_id: boundedId(context["lix.request.id"]) }
							: {}),
					},
				};
			}),
		)
	).filter((event) => event !== null);
}

/** Project safe app frames and a bounded cause chain into PostHog's shape. */
function exceptionList(
	fields: Record<string, string>,
	type: string,
	message: string,
	suppressCauseMessages = false,
): Array<Record<string, unknown>> {
	const result = [
		exceptionEntry(
			type,
			message,
			fields["exception.stacktrace"],
			fields["exception.type"],
			fields["exception.message"],
		),
	];
	const count = Number(fields["exception.cause.count"]);
	if (!Number.isInteger(count) || count < 1 || count > 4) return result;
	for (let index = 0; index < count; index++) {
		const prefix = `exception.cause.${index}`;
		const causeType = safeExceptionType(fields[`${prefix}.type`], "Error");
		const causeMessage = fields[`${prefix}.message`];
		const stacktrace = fields[`${prefix}.stacktrace`];
		const frames = applicationExceptionFrames(
			stacktrace,
			causeType,
			causeMessage,
		);
		if (!causeMessage && !stacktrace && frames.length === 0) continue;
		result.push(
			exceptionEntry(
				causeType,
				causeMessage && !suppressCauseMessages
					? diagnostic(causeMessage)
					: `Caused by ${causeType}`,
				stacktrace,
				causeType,
				causeMessage,
			),
		);
	}
	return result;
}

function exceptionEntry(
	type: string,
	value: string,
	stacktrace: string | undefined,
	stackName?: string,
	stackMessage?: string,
): Record<string, unknown> {
	const frames = applicationExceptionFrames(
		stacktrace,
		stackName,
		stackMessage,
	);
	return {
		type,
		value,
		mechanism: { type: "generic", handled: true },
		...(frames.length > 0 ? { stacktrace: { type: "raw", frames } } : {}),
	};
}

/** Application-owned fields sufficient to replay a download without its private bytes. */
function snapshotReproductionContext(
	name: string | undefined,
	fields: Record<string, string>,
): Record<string, unknown> {
	if (
		name !== "repository.snapshot.download" ||
		fields["snapshot.action"] !== "download_remote_snapshot"
	)
		return {};
	const repositoryId = boundedId(fields["lix.id"]);
	const stage = fields["snapshot.failure_stage"];
	const attempt = fields["snapshot.attempt_id"];
	return {
		reproduction: {
			action: "download_remote_snapshot",
			...(repositoryId ? { repository_id: repositoryId } : {}),
			method: "GET",
			endpoint: "/lix/v1/{lix_id}/snapshot",
		},
		lix_request_endpoint: "snapshot",
		lix_request_method: "GET",
		...([
			"request_headers",
			"request",
			"http_response",
			"response_body",
			"download",
		].includes(stage ?? "")
			? { failure_stage: stage }
			: {}),
		...(safeUuid(attempt) ? { snapshot_attempt_id: safeUuid(attempt) } : {}),
	};
}
