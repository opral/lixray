import assert from "node:assert/strict";
import protobuf from "protobufjs/light.js";
import schema from "../../src/worker/otlp-traces.schema.json" with { type: "json" };
import { expect, test, type Route } from "@playwright/test";

const traceRequestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

type WireAttribute = { key?: string; value?: Record<string, unknown> };
type WireSpan = {
	name?: string;
	attributes?: WireAttribute[];
};
type DecodedTraceRequest = {
	resourceSpans?: Array<{
		scopeSpans?: Array<{ spans?: WireSpan[] }>;
	}>;
};
type CapturedSpan = {
	name: string;
	attributes: Record<string, unknown>;
	attributeKeys: string[];
};

declare global {
	interface Window {
		runRepositoryOpeningFixture: () => Promise<{
			initialized: boolean;
			resourceResponseStatus: number;
			openSpanCountAfterFirstPaint: number;
			openSpanCountAfterSecondPaint: number;
		}>;
	}
}

function captureSpans(route: Route): CapturedSpan[] {
	const request = route.request();
	const body = request.postDataBuffer() ?? Buffer.alloc(0);
	if (body.byteLength === 0) return [];
	const decoded = traceRequestType.decode(body) as DecodedTraceRequest;
	const spans: CapturedSpan[] = [];
	for (const resource of decoded.resourceSpans ?? []) {
		for (const scope of resource.scopeSpans ?? []) {
			for (const span of scope.spans ?? []) {
				const attributes: Record<string, unknown> = {};
				const attributeKeys: string[] = [];
				for (const attribute of span.attributes ?? []) {
					if (!attribute.key || !attribute.value) continue;
					attributeKeys.push(attribute.key);
					const valueKey = [
						"stringValue",
						"boolValue",
						"intValue",
						"doubleValue",
					].find((candidate) => Object.hasOwn(attribute.value!, candidate));
					if (!valueKey) continue;
					const value = attribute.value[valueKey];
					attributes[attribute.key] =
						value && typeof value === "object" && "low" in value
							? Number(value.low)
							: value;
				}
				spans.push({ name: span.name ?? "", attributes, attributeKeys });
			}
		}
	}
	return spans;
}

test("an actual fresh SDK open reaches OTLP with a safe browser profile", async ({
	page,
}) => {
	const wireSpans: CapturedSpan[] = [];
	let otlpRequests = 0;
	let resourceRequests = 0;
	await page.route(
		"**/api/repository-open-profile-resource**",
		async (route) => {
			resourceRequests++;
			await new Promise((resolve) => setTimeout(resolve, 25));
			await route.fulfill({
				status: 200,
				headers: { "cache-control": "no-store" },
				contentType: "application/octet-stream",
				body: Buffer.from("timing-only fixture"),
			});
		},
	);
	await page.route("**/__fixture/otlp/v1/traces", async (route) => {
		otlpRequests++;
		assert.equal(route.request().method(), "POST");
		assert.match(
			route.request().headers()["content-type"] ?? "",
			/application\/x-protobuf/u,
		);
		wireSpans.push(...captureSpans(route));
		await route.fulfill({
			status: 200,
			contentType: "application/x-protobuf",
			body: Buffer.alloc(0),
		});
	});

	const response = await page.goto("/repository-opening.html");
	expect(response?.ok()).toBe(true);
	const result = await page.evaluate(() =>
		window.runRepositoryOpeningFixture(),
	);
	assert.equal(result.initialized, true);
	assert.equal(result.resourceResponseStatus, 200);
	assert.equal(result.openSpanCountAfterFirstPaint, 0);
	assert.equal(result.openSpanCountAfterSecondPaint, 1);
	expect(resourceRequests).toBe(1);
	expect(otlpRequests).toBe(1);

	const roots = wireSpans.filter(
		(span) => span.name === "lixray.repository.open",
	);
	expect(roots).toHaveLength(1);
	const root = roots[0]!;
	const attributes = root.attributes;
	expect(attributes["lixray.repository.open.outcome"]).toBe("usable");
	expect(attributes["lixray.repository.open.terminal_phase"]).toBe("paint");
	expect(attributes["lixray.repository.open.replica_state"]).toBe("fresh");
	expect(attributes["lixray.repository.open.initialized_this_open"]).toBe(true);
	expect(attributes["lixray.repository.open.engine_attempts"]).toBe(1);
	expect(attributes["lixray.repository.open.session_acquisition"]).toBe(
		"created",
	);
	expect(
		attributes["lixray.repository.open.profile.resource_timing_supported"],
	).toBe(true);
	expect(
		attributes["lixray.repository.open.profile.navigation_timing_supported"],
	).toBe(true);
	expect(attributes["lixray.repository.open.profile.dns_ms"]).toBeUndefined();
	expect(attributes["lixray.repository.open.profile.ttfb_ms"]).toBeUndefined();
	expect(attributes["lixray.repository.open.profile.longtask_supported"]).toBe(
		true,
	);
	expect(attributes["lixray.repository.open.profile.interval_valid"]).toBe(
		true,
	);
	expect(
		attributes["lixray.repository.open.profile.resources.api.count"],
	).toBeGreaterThanOrEqual(1);
	expect(
		attributes["lixray.repository.open.profile.resources.api.duration_ms"],
	).toBeGreaterThan(0);
	expect(attributes["lixray.repository.open.profile.resources.truncated"]).toBe(
		false,
	);
	expect(attributes["lixray.repository.open.profile.browser_family"]).toMatch(
		/^(chrome|edge|firefox|safari|other)$/u,
	);
	expect(
		typeof attributes["lixray.repository.open.profile.browser_major"],
	).toBe("number");
	expect(
		attributes["lixray.repository.open.profile.browser_major"],
	).toBeGreaterThanOrEqual(1);
	expect(
		attributes["lixray.repository.open.profile.browser_major"],
	).toBeLessThanOrEqual(1_000);
	const nativePhaseSpans = wireSpans.filter((span) =>
		span.name.startsWith("lixray.repository.open.native.local."),
	);
	expect(nativePhaseSpans.length).toBeGreaterThan(0);
	expect(
		root.attributeKeys.some(
			(key) =>
				key.startsWith("lixray.repository.open.native.local.") &&
				key.endsWith("_ms"),
		),
	).toBe(true);
	expect(attributes["lixray.repository.open.host.version"]).toBe(1);
	expect(
		typeof attributes["lixray.repository.open.host.wasm.realm_reused"],
	).toBe("boolean");
	expect(typeof attributes["lixray.repository.open.host.wasm.source"]).toBe(
		"string",
	);
	expect(
		typeof attributes["lixray.repository.open.host.wasm.cache_status"],
	).toBe("string");
	expect(typeof attributes["lixray.repository.open.host.wasm.wait_ms"]).toBe(
		"number",
	);
	const hostKeys = root.attributeKeys.filter((key) =>
		key.startsWith("lixray.repository.open.host."),
	);
	expect(hostKeys.length).toBeGreaterThan(0);
	expect(new Set(hostKeys).size).toBe(hostKeys.length);
	const serializedPayload = JSON.stringify(wireSpans);
	expect(serializedPayload).not.toMatch(
		/repository-open-profile-resource|wire-test-secret|private=|https?:\/\//u,
	);
});
