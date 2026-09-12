/** Project server diagnostics at the authenticated gateway, never in HTTP errors. */
interface OtlpAttribute {
	key?: string;
	value?: {
		stringValue?: string;
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

export async function serverErrorEvents(span: OtlpSpan) {
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
	return (
		await Promise.all(
			(span.events ?? []).map(async (event, index) => {
				const fields = attributes(event.attributes);
				// A span's ERROR status alone can mean a retryable 503. Capture actual logs.
				if (fields.level !== "ERROR" && event.name !== "exception") return null;
				const message =
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
				const type = fields["exception.type"] ?? "LixServerError";
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
					distinct_id: account || `lix-server:${lixId ?? "system"}`,
					uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
					timestamp,
					properties: {
						$exception_list: [
							{ type, value, mechanism: { type: "generic", handled: true } },
						],
						$exception_level: "error",
						$exception_source: "server",
						$process_person_profile: false,
						$geoip_disable: true,
						$otel_trace_id: traceId,
						$otel_span_id: spanId,
						$ai_trace_id: traceId,
						$ai_span_id: spanId,
						environment: "production",
						source: "server",
						service: "lix-server",
						server_span_name: span.name,
						server_log_message: summary,
						server_error_detail: value,
						...(lixId ? { lix_id: lixId, repository_id: lixId } : {}),
						...(context["lix.request.id"]
							? { request_id: context["lix.request.id"] }
							: {}),
						...(fields.from_version
							? { migration_from_version: fields.from_version }
							: {}),
						...(fields.to_version
							? { migration_to_version: fields.to_version }
							: {}),
					},
				};
			}),
		)
	).filter((event) => event !== null);
}
