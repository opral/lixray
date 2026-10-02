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
import { lixErrorTelemetryProperties } from "./telemetry.ts";
import {
	applicationExceptionFrames,
	applicationExceptionAttributes,
	safeRustErrorOrigin,
} from "./exception-stack-trace.ts";
import type { CaptureResult } from "posthog-js";

void test("all exception boundaries preserve actual traces and create standalone error traces", async () => {
	const viteFrames = applicationExceptionFrames(
		"Error: query failed\n    at execute (http://127.0.0.1:8796/@fs/root/private/web-app/src/lib/repository-snapshot-telemetry.ts:44:9)",
		"Error",
		"query failed",
	);
	assert.deepEqual(viteFrames, [
		{
			platform: "web:javascript",
			filename: "/src/lib/repository-snapshot-telemetry.ts",
			function: "execute",
			lineno: 44,
			colno: 9,
			in_app: true,
		},
	]);
	assert.doesNotMatch(JSON.stringify(viteFrames), /root\/private/);
	const traversalFrames = applicationExceptionFrames(
		"Error\n    at execute (https://app.example/src/../private.ts:44:9)",
		"Error",
		undefined,
	);
	assert.deepEqual(traversalFrames, []);

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

		const nativeError = Object.assign(new Error("Native bridge failed"), {
			name: "LixError",
			code: "LIX_NATIVE_ERROR",
			rustOrigin: {
				kind: "source_location",
				file: "packages/lix/src/storage.rs",
				line: 77,
				column: 9,
			},
			rustStacktraceStatus: "not_captured",
			cause: new Error(
				"Planning failed at /home/private/repository; SELECT private_column FROM secret_table",
			),
		});
		assert.deepEqual(safeRustErrorOrigin(nativeError), {
			kind: "source_location",
			file: "packages/lix/src/storage.rs",
			line: 77,
			column: 9,
		});
		assert.deepEqual(lixErrorTelemetryProperties(nativeError).rust_origin, {
			kind: "source_location",
			file: "packages/lix/src/storage.rs",
			line: 77,
			column: 9,
		});
		assert.equal(
			lixErrorTelemetryProperties(nativeError).rust_stacktrace_status,
			"not_captured",
		);
		assert.equal(
			applicationExceptionAttributes(nativeError)["exception.rust_origin.file"],
			"packages/lix/src/storage.rs",
		);
		const nativeAttributes = applicationExceptionAttributes(nativeError);
		assert.equal(nativeAttributes["exception.message"], "LIX_NATIVE_ERROR");
		assert.equal(nativeAttributes["exception.cause.0.type"], "Error");
		assert.equal(nativeAttributes["exception.cause.0.message"], undefined);
		assert.doesNotMatch(
			JSON.stringify(nativeAttributes),
			/private_column|secret_table|private\/repository|Planning failed/,
		);
		const wrapper = new Error("wrapper failed", { cause: nativeError });
		const wrappedAttributes = applicationExceptionAttributes(wrapper);
		assert.equal(
			wrappedAttributes["exception.rust_origin.file"],
			"packages/lix/src/storage.rs",
		);
		assert.equal(wrappedAttributes["exception.rust_origin.cause_index"], "0");
		const wrappedProperties = lixErrorTelemetryProperties(wrapper);
		assert.deepEqual(wrappedProperties.rust_origin, {
			kind: "source_location",
			file: "packages/lix/src/storage.rs",
			line: 77,
			column: 9,
		});
		assert.equal(wrappedProperties.rust_origin_cause_index, 0);
		assert.equal(wrappedProperties.rust_stacktrace_status, "not_captured");
		assert.equal(
			safeRustErrorOrigin({
				rustOrigin: {
					kind: "source_location",
					file: "/home/build/packages/lix/src/storage.rs",
					line: 77,
					column: 9,
				},
			}),
			undefined,
		);
		assert.equal(
			safeRustErrorOrigin({
				rustOrigin: {
					kind: "source_location",
					file: "src/storage.rs",
					line: 77,
				},
			}),
			undefined,
		);
	} finally {
		await provider.shutdown();
		trace.disable();
	}
});
