import protobuf from "protobufjs/light.js";
import schema from "./otlp-traces.schema.json" with { type: "json" };
import { serverErrorEvents, type OtlpSpan } from "./otlp-server-errors.ts";

export interface OtlpTelemetryEnvironment {
	LIXRAY_INTERNAL_TOKEN?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
}

interface TraceRequest {
	resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
}

// Generated from the official trace-service proto, never a custom wire format.
const traceRequestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

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

/** Lix emits one vendor-neutral OTLP stream; this gateway owns PostHog routing. */
export async function handleOtlpTelemetry(
	request: Request,
	env: OtlpTelemetryEnvironment,
	dependencies: { fetch?: typeof fetch; authenticatedBrowser?: boolean } = {},
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
	if (!env.POSTHOG_PROJECT_TOKEN || env.POSTHOG_ENVIRONMENT !== "production") {
		return new Response("Telemetry destination is not configured", {
			status: 503,
		});
	}
	const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
	try {
		const host = new URL(env.POSTHOG_HOST ?? "https://us.i.posthog.com");
		if (!["https:", "http:"].includes(host.protocol))
			return new Response("Invalid telemetry destination", { status: 503 });
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
		const opens = (await Promise.all(spans.map(openedEvent))).filter(
			(event) => event !== null,
		);
		const errors = (await Promise.all(spans.map(serverErrorEvents))).flat();
		const events = [...opens, ...errors];
		const fetcher = dependencies.fetch ?? fetch;
		const deliveries = [
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
		for (const result of results) {
			if (result.status === "rejected") {
				delivered = false;
				continue;
			}
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
		return new Response(
			error instanceof InputError ? error.message : "Telemetry delivery failed",
			{
				status: error instanceof InputError ? error.status : 503,
			},
		);
	}
}
