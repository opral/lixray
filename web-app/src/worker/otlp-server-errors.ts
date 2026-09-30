import {
	repositoryOpenDiagnostics,
	repositoryOpenFailureMessage,
} from "../lib/repository-open-telemetry.ts";

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

/** Bound diagnostics and redact credentials that can occur in transport errors. */
function diagnostic(value: string): string {
	return (
		value
			// ANSI styling is useful in Railway's console, not in captured exceptions.
			// eslint-disable-next-line no-control-regex
			.replace(/\x1b\[[0-9;]*m/g, "")
			.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
			.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
			.replace(
				/([?&](?:[^=\s&]*(?:token|secret|password|signature|credential|key)[^=\s&]*)=)[^\s&#"']*/gi,
				"$1[REDACTED]",
			)
			.slice(0, 16_384)
	);
}

export async function serverErrorEvents(
	span: OtlpSpan,
	options: {
		source?: "server" | "browser";
		resourceAttributes?: OtlpAttribute[];
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
	const resource = attributes(options.resourceAttributes);
	const source = options.source ?? "server";
	const candidateCode = context["lix.error.code"] ?? context["error.type"];
	const failureCode =
		candidateCode && /^LIX_[A-Z0-9_]{1,100}$/.test(candidateCode)
			? candidateCode
			: undefined;
	const migrationCause = repositoryOpenDiagnostics({
		details: {
			failureReason: context["lix.migration.failure_reason"],
			failurePath: context["lix.migration.failure_path"],
			payloadFailureReason: context["lix.payload.failure_reason"],
		},
	});
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
					value: { stringValue: failureCode ?? "LixOperationError" },
				},
				{
					key: "exception.message",
					value: {
						stringValue: repositoryOpenFailureMessage(
							{ details: migrationCause },
							failureCode ?? "Lix operation failed",
						),
					},
				},
			],
		});
	}
	const details: Record<string, unknown> = {};
	for (const [key, field] of [
		["lix.error.source_code", "sourceCode"],
		["lix.migration.phase", "migrationPhase"],
		["lix.migration.from_version", "fromVersion"],
		["lix.migration.to_version", "toVersion"],
		["lix.migration.failure_reason", "failureReason"],
		["lix.migration.failure_path", "failurePath"],
		["lix.migration.json_line", "jsonLine"],
		["lix.migration.json_column", "jsonColumn"],
		["lix.migration.missing_field", "missingField"],
		["lix.receipt.version", "receiptVersion"],
		["lix.receipt.expected_version", "expectedReceiptVersion"],
		["http.response.status_code", "httpStatus"],
		["lix.recovery.attempts", "recoveryAttempts"],
		["lix.recovery.stage", "recoveryStage"],
		["lix.payload.standalone_status", "payloadStandaloneStatus"],
		["lix.payload.physical_status", "payloadPhysicalStatus"],
		["lix.payload.failure_reason", "payloadFailureReason"],
		["lix.payload.change_id", "changeId"],
		["lix.payload.source_commit_id", "sourceCommitId"],
	])
		details[field!] = context[key!];
	for (const [key, field] of [
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
				const message =
					structuredFailureMessage ??
					fields["exception.message"] ??
					fields.error ??
					fields.message ??
					event.name;
				if (!message) return null;
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
				const lixId =
					fields.lix_id ?? context["lix.id"] ?? context["lix.lix.id"];
				const account = context["lix.account_id"];
				const value = diagnostic(message);
				const summary = diagnostic(
					fields.message ?? event.name ?? "Server error",
				);
				const type =
					fields["exception.type"] ??
					failureCode ??
					(source === "server" ? "LixServerError" : "LixBrowserError");
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
				return {
					event: "$exception",
					distinct_id: account || `lix-${source}:${lixId ?? "system"}`,
					uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
					timestamp,
					properties: {
						$exception_list: [
							{ type, value, mechanism: { type: "generic", handled: true } },
						],
						$exception_level: "error",
						$exception_source: source,
						$process_person_profile: false,
						$geoip_disable: true,
						$otel_trace_id: traceId,
						$otel_span_id: spanId,
						$ai_trace_id: traceId,
						$ai_span_id: spanId,
						environment: "production",
						source,
						service: source === "server" ? "lix-server" : "lix-browser",
						...structural,
						...repositoryOpenDiagnostics({
							details: {
								fromVersion: fields.from_version,
								toVersion: fields.to_version,
							},
						}),
						operation: span.name,
						server_span_name: span.name,
						server_log_message: summary,
						server_error_detail: value,
						...(lixId ? { lix_id: lixId, repository_id: lixId } : {}),
						...(context["lix.request.id"]
							? { request_id: context["lix.request.id"] }
							: {}),
					},
				};
			}),
		)
	).filter((event) => event !== null);
}
