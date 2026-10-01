import assert from "node:assert/strict";
import test from "node:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import protobuf from "protobufjs/light.js";
import schema from "./worker/otlp-traces.schema.json" with { type: "json" };
import {
	createLixTelemetryOptions,
	lixTelemetryParentContext,
	mergeOtlpRequests,
	stampLixResource,
} from "./browser-telemetry.ts";

const requestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

function encodeRequest(name: string): Uint8Array {
	return requestType
		.encode({
			resourceSpans: [
				{
					scopeSpans: [
						{
							scope: { name: "lix", version: "0.17.1" },
							spans: [
								{
									traceId: new Uint8Array(16).fill(1),
									spanId: new Uint8Array(8).fill(2),
									name,
									kind: 2,
									startTimeUnixNano: "1",
									endTimeUnixNano: "2",
								},
							],
						},
					],
				},
			],
		})
		.finish();
}

void test("browser uploader stamps host resource identity and merges OTLP requests", () => {
	const first = stampLixResource(encodeRequest("SELECT"), "repo-one");
	const second = stampLixResource(encodeRequest("UPDATE"), "repo-two");
	const decoded = requestType.decode(mergeOtlpRequests([first, second]));
	const output = requestType.toObject(decoded, {
		bytes: Uint8Array,
		defaults: false,
	}) as {
		resourceSpans: Array<{
			resource: {
				attributes: Array<{ key: string; value: { stringValue: string } }>;
			};
			scopeSpans: Array<{ spans: Array<{ name: string }> }>;
		}>;
	};
	assert.deepEqual(
		output.resourceSpans.map((resourceSpan) =>
			Object.fromEntries(
				resourceSpan.resource.attributes.map((attribute) => [
					attribute.key,
					attribute.value.stringValue,
				]),
			),
		),
		[
			{
				"lix.id": "repo-one",
				"service.name": "lixray-web",
				"service.version": "unknown",
			},
			{
				"lix.id": "repo-two",
				"service.name": "lixray-web",
				"service.version": "unknown",
			},
		],
	);
	assert.deepEqual(
		output.resourceSpans.flatMap((resourceSpan) =>
			resourceSpan.scopeSpans.flatMap((scope) =>
				scope.spans.map((span) => span.name),
			),
		),
		["SELECT", "UPDATE"],
	);
});

void test("Lix SDK span identity follows a public route alias", () => {
	const request = requestType
		.encode({
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{
									traceId: new Uint8Array(16).fill(1),
									spanId: new Uint8Array(8).fill(2),
									name: "lix.engine.open",
									attributes: [
										{
											key: "lix.id",
											value: { stringValue: "embedded-id" },
										},
										{
											key: "lix.id",
											value: { stringValue: "embedded-id-alias" },
										},
										{
											key: "lix.branch_id",
											value: { stringValue: "branch-id" },
										},
									],
								},
							],
						},
					],
				},
			],
		})
		.finish();
	const decoded = requestType.decode(
		stampLixResource(request, "public-route-id"),
	);
	const output = requestType.toObject(decoded, {
		bytes: Uint8Array,
		defaults: false,
	}) as {
		resourceSpans: Array<{
			scopeSpans: Array<{
				spans: Array<{
					attributes: Array<{ key: string; value: { stringValue: string } }>;
				}>;
			}>;
		}>;
	};
	const attributes = Object.fromEntries(
		output.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.map(
			(attribute) => [attribute.key, attribute.value.stringValue],
		),
	);
	assert.equal(attributes["lix.id"], "public-route-id");
	assert.equal(attributes["lix.branch_id"], "branch-id");
	assert.deepEqual(
		output.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.filter(
			(attribute) => attribute.key === "lix.id",
		).map((attribute) => attribute.value.stringValue),
		["public-route-id", "public-route-id"],
	);
	assert.doesNotMatch(JSON.stringify(output), /embedded-id/);
});

void test("Lix parent context follows the active browser W3C trace context", () => {
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	const activeSpan = trace.wrapSpanContext({
		traceId: "0123456789abcdef0123456789abcdef",
		spanId: "0123456789abcdef",
		traceFlags: 1,
	});
	const activeContext = trace.setSpan(context.active(), activeSpan);
	const parent = lixTelemetryParentContext(activeContext);
	assert.deepEqual(parent, {
		traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	});
});

void test("Lix uploader retains a failed batch and clears it only after delivery", async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const originalFetch = globalThis.fetch;
	const originalWarn = console.warn;
	let attempts = 0;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { origin: "https://lixray.com" } },
	});
	globalThis.fetch = async () => {
		attempts += 1;
		return new Response(null, { status: attempts === 1 ? 503 : 204 });
	};
	console.warn = () => {};
	try {
		const telemetry = createLixTelemetryOptions(
			"repo-one",
			async () => "token",
		);
		assert.equal(typeof telemetry.flush, "function");
		const flush = async () => {
			await telemetry.flush?.();
		};
		await Promise.resolve(telemetry.onExport(encodeRequest("SELECT")));
		await flush();
		assert.equal(attempts, 1);
		await flush();
		assert.equal(attempts, 2);
		await flush();
		assert.equal(attempts, 2);
	} finally {
		console.warn = originalWarn;
		globalThis.fetch = originalFetch;
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", originalWindow);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	}
});

void test("public repository Lix uploader sends its repository scope without a user token", async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const originalFetch = globalThis.fetch;
	let requestHeaders: Headers | undefined;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { origin: "https://lixray.com" } },
	});
	globalThis.fetch = async (_input, init) => {
		requestHeaders = new Headers(init?.headers);
		return new Response(null, { status: 200 });
	};
	try {
		const telemetry = createLixTelemetryOptions(
			"repo-public",
			async () => null,
		);
		await Promise.resolve(
			telemetry.onExport(encodeRequest("lixray.repository.open")),
		);
		await telemetry.flush?.();
		assert.equal(requestHeaders?.get("x-lixray-repository-id"), "repo-public");
		assert.equal(requestHeaders?.get("authorization"), null);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", originalWindow);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	}
});
