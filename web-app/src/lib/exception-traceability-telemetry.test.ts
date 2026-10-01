import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	exceptionTraceability,
	preparePostHogEvent,
} from "./exception-traceability.ts";
import type { CaptureResult } from "posthog-js";

void test("all exception boundaries preserve actual traces and create standalone error traces", async () => {
	const exporter = new InMemorySpanExporter();
	const provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	provider.register();
	try {
		const standalone = exceptionTraceability({
			operation: "repository.reset",
			$otel_trace_id: "invalid",
			error_id: "------------------------------------",
		});
		assert.match(
			String(standalone.error_id),
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
		);
		assert.equal(standalone.error_correlation, "standalone_trace");
		const span = exporter.getFinishedSpans()[0]!;
		assert.equal(standalone.$otel_trace_id, span.spanContext().traceId);
		assert.equal(standalone.$otel_span_id, span.spanContext().spanId);
		assert.equal(span.attributes["exception.capture_id"], standalone.error_id);
		assert.equal(span.status.code, 2);

		await trace
			.getTracer("test")
			.startActiveSpan("repository.open", async (active) => {
				const captured = exceptionTraceability({
					operation: "repository.open",
				});
				// Simulate async PostHog initialization and the common before_send boundary.
				await Promise.resolve();
				const event = preparePostHogEvent({
					uuid: crypto.randomUUID(),
					event: "$exception",
					properties: {
						...captured,
						sql: "SELECT private contents",
						authorization: "Bearer private-token",
						$exception_list: [
							{
								type: "Error",
								value: "Opening failed",
								stacktrace: {
									frames: [
										{
											vars: { privateDocument: "secret contents" },
											filename: "https://example.com/app.js?token=secret",
										},
									],
								},
							},
						],
					},
				} as CaptureResult);
				assert.equal(
					event?.properties.$otel_trace_id,
					active.spanContext().traceId,
				);
				assert.equal(
					event?.properties.$otel_span_id,
					active.spanContext().spanId,
				);
				assert.equal(event?.properties.error_id, captured.error_id);
				assert.equal(event?.properties.error_correlation, "active_trace");
				assert.equal(event?.properties.service_name, "lixray-web");
				assert.doesNotMatch(
					JSON.stringify(event),
					/private contents|private-token|secret contents|token=secret/,
				);
				active.end();
			});
		assert.equal(preparePostHogEvent(null), null);
	} finally {
		await provider.shutdown();
		trace.disable();
	}
});
