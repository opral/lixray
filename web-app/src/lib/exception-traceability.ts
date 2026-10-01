import { trace, SpanStatusCode, isSpanContextValid } from "@opentelemetry/api";
import type { CaptureResult, Properties } from "posthog-js";
import { scrubPostHogEvent } from "./telemetry-privacy.ts";

/** Capture synchronously: SDK initialization must not change the error's trace. */
export function exceptionTraceability(properties: Properties = {}): Properties {
	const input: Record<string, unknown> = properties;
	const operation =
		typeof input.operation === "string" &&
		/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(input.operation)
			? input.operation
			: "browser.exception";
	const errorId =
		typeof input.error_id === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			input.error_id,
		)
			? input.error_id
			: crypto.randomUUID();
	const traceId = input.$otel_trace_id;
	const spanId = input.$otel_span_id;
	const explicit =
		typeof traceId === "string" &&
		/^[a-f0-9]{32}$/.test(traceId) &&
		!/^0+$/.test(traceId) &&
		typeof spanId === "string" &&
		/^[a-f0-9]{16}$/.test(spanId) &&
		!/^0+$/.test(spanId);
	const safeProperties = { ...properties };
	delete safeProperties.$otel_trace_id;
	delete safeProperties.$otel_span_id;
	const activeSpan = trace.getActiveSpan();
	let spanContext = activeSpan?.spanContext();
	if (!explicit && spanContext && isSpanContextValid(spanContext)) {
		activeSpan?.setAttribute("exception.capture_id", errorId);
		activeSpan?.setStatus({ code: SpanStatusCode.ERROR });
	}
	let standalone = false;
	if (!explicit && (!spanContext || !isSpanContextValid(spanContext))) {
		const span = trace.getTracer("lixray").startSpan(operation, {
			attributes: {
				"exception.capture_id": errorId,
				"error.type": "browser_exception",
			},
		});
		spanContext = span.spanContext();
		span.setStatus({ code: SpanStatusCode.ERROR });
		span.end();
		standalone = true;
	}
	return {
		...safeProperties,
		operation,
		error_id: errorId,
		service_name: "lixray-web",
		client_release: import.meta.env?.VITE_LIXRAY_RELEASE_ID ?? "unknown",
		...(explicit
			? {
					$otel_trace_id: traceId,
					$otel_span_id: spanId,
					error_correlation:
						input.error_correlation === "active_trace" ||
						input.error_correlation === "standalone_trace"
							? input.error_correlation
							: "provided_trace",
				}
			: spanContext && isSpanContextValid(spanContext)
				? {
						$otel_trace_id: spanContext.traceId,
						$otel_span_id: spanContext.spanId,
						error_correlation: standalone ? "standalone_trace" : "active_trace",
					}
				: { error_correlation: "no_trace_provider" }),
	};
}

/** Also enrich PostHog's uncaught error and rejection captures. */
export function preparePostHogEvent(
	event: CaptureResult | null,
): CaptureResult | null {
	if (event?.event === "$exception")
		event = { ...event, properties: exceptionTraceability(event.properties) };
	return scrubPostHogEvent(event);
}
