import {
	context,
	propagation,
	trace,
	SpanKind,
	SpanStatusCode,
	ROOT_CONTEXT,
	type Attributes,
	type Context,
	type Span,
} from "@opentelemetry/api";

import { repositoryOpenDiagnostics } from "./lib/repository-open-telemetry.ts";

export const tracer = trace.getTracer("lixray");

/** Only bounded, application-owned error categories belong in traces. */
export function failSpan(span: Span, category = "operation_failed"): void {
	span.setAttribute("error.type", category);
	span.setStatus({ code: SpanStatusCode.ERROR });
}

export function withSpan<T>(
	name: string,
	operation: (span: Span) => Promise<T>,
	attributes: Attributes = {},
): Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, async (span) => {
		try {
			return await operation(span);
		} catch (error) {
			const diagnostic = repositoryOpenDiagnostics(error);
			failSpan(
				span,
				typeof diagnostic.lix_error_code === "string"
					? diagnostic.lix_error_code
					: "operation_failed",
			);
			for (const [key, field] of [
				["sourceCode", "lix.error.source_code"],
				["migrationPhase", "lix.migration.phase"],
				["fromVersion", "lix.migration.from_version"],
				["toVersion", "lix.migration.to_version"],
				["failureReason", "lix.migration.failure_reason"],
				["failurePath", "lix.migration.failure_path"],
				["jsonLine", "lix.migration.json_line"],
				["jsonColumn", "lix.migration.json_column"],
				["missingField", "lix.migration.missing_field"],
				["receiptVersion", "lix.receipt.version"],
				["expectedReceiptVersion", "lix.receipt.expected_version"],
				["httpStatus", "http.response.status_code"],
				["recoveryStage", "lix.recovery.stage"],
				["recoveryAttempts", "lix.recovery.attempts"],
				["retryable", "lix.error.retryable"],
				["admissionRetryExhausted", "lix.recovery.retry_exhausted"],
				["recoveryDeadlineExceeded", "lix.recovery.deadline_exceeded"],
				["payloadFailureReason", "lix.payload.failure_reason"],
				["payloadPhysicalStatus", "lix.payload.physical_status"],
				["changeId", "lix.payload.change_id"],
			]) {
				const value = diagnostic[key!];
				if (
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean"
				)
					span.setAttribute(field!, value);
			}
			throw error;
		} finally {
			span.end();
		}
	});
}

/** Own a response span until consumption, cancellation, or failure, exactly once. */
export function traceResponse(
	response: Response,
	span: Span,
	spanContext: Context = trace.setSpan(context.active(), span),
	signal?: AbortSignal,
): Response {
	let ended = false;
	const finish = (error?: string) => {
		if (ended) return;
		ended = true;
		signal?.removeEventListener("abort", aborted);
		if (error && response.status < 400) failSpan(span, error);
		span.end();
	};
	const aborted = () => finish("cancelled");
	if (signal?.aborted) aborted();
	else signal?.addEventListener("abort", aborted, { once: true });
	if (!response.body) {
		finish();
		return response;
	}
	const reader = response.body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>(
			{
				pull: (controller) =>
					context.with(spanContext, async () => {
						try {
							const result = await reader.read();
							if (result.done) {
								finish();
								controller.close();
							} else controller.enqueue(result.value);
						} catch (error) {
							finish("response_body_failed");
							controller.error(error);
						}
					}),
				cancel: (reason) =>
					context.with(spanContext, async () => {
						try {
							await reader.cancel(reason);
						} finally {
							finish("cancelled");
						}
					}),
			},
			{ highWaterMark: 0 },
		),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

/** Shared boundary for handshake, provisioning, SQL, transactions and close. */
export function fetchLixWithTrace(
	lixId: string,
	request: Request,
	fetcher: (lixId: string, request: Request) => Promise<Response>,
	openingParent?: { traceparent: string; tracestate?: string },
): Promise<Response> {
	// Never include query strings, SQL, session identifiers, or credentials.
	const route = new URL(request.url).pathname
		.replace(/\/lix\/v1\/[^/]+/, "/lix/v1/{lix_id}")
		.replace(/\/sessions\/[^/]+/, "/sessions/{session_id}")
		.replace(/\/transactions\/[^/]+/, "/transactions/{transaction_id}");
	// Browser SDK operations arrive from a worker. Their W3C headers are the
	// request-specific parent; the main thread's active context is unrelated.
	const parentCarrier = new Headers(request.headers);
	if (!parentCarrier.has("traceparent") && openingParent) {
		parentCarrier.set("traceparent", openingParent.traceparent);
		if (openingParent.tracestate)
			parentCarrier.set("tracestate", openingParent.tracestate);
	}
	const parent = parentCarrier.has("traceparent")
		? propagation.extract(ROOT_CONTEXT, parentCarrier, {
				get: (carrier, key) => carrier.get(key) ?? undefined,
				keys: (carrier) => Array.from(carrier.keys()),
			})
		: context.active();
	return tracer.startActiveSpan(
		"lix.client.rpc",
		{
			kind: SpanKind.CLIENT,
			attributes: {
				"lix.id": lixId,
				"http.request.method": request.method,
				"http.route": route,
			},
		},
		parent,
		async (span) => {
			try {
				const headers = new Headers(request.headers);
				headers.delete("traceparent");
				headers.delete("tracestate");
				propagation.inject(context.active(), headers, {
					set: (carrier, key, value) => carrier.set(key, value),
				});
				const response = await fetcher(
					lixId,
					new Request(request, { headers }),
				);
				span.setAttribute("http.response.status_code", response.status);
				if (response.status >= 400) failSpan(span, `HTTP_${response.status}`);
				return traceResponse(response, span, context.active(), request.signal);
			} catch (error) {
				failSpan(span, request.signal.aborted ? "cancelled" : "fetch_failed");
				span.end();
				throw error;
			}
		},
	);
}
