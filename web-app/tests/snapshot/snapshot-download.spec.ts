import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "../../src/worker/otlp-traces.schema.json" with {
	type: "json",
};
import { expect, test, type Route } from "@playwright/test";

const REPOSITORY_ID = "123e4567-e89b-12d3-a456-426614174000";
const AUTH_SECRET = "snapshot-fixture-auth-secret";
const QUERY_SECRET = "snapshot-fixture-query-secret";
const BODY_SECRET = "snapshot-fixture-private-response-body";
const traceRequestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

function flattenAttributes(
	attributes: Array<{ key?: string; value?: Record<string, unknown> }> = [],
): Record<string, unknown> {
	return Object.fromEntries(
		attributes.flatMap(({ key, value }) => {
			if (!key || !value) return [];
			const valueKey = [
				"stringValue",
				"boolValue",
				"intValue",
				"doubleValue",
			].find((candidate) => Object.hasOwn(value, candidate));
			if (!valueKey) return [];
			const attributeValue = value[valueKey];
			return [
				[
					key,
					attributeValue &&
					typeof attributeValue === "object" &&
					"low" in attributeValue
						? Number(attributeValue.low)
						: attributeValue,
				],
			];
		}),
	);
}

function hex(value: Uint8Array | number[] | undefined): string | undefined {
	return value
		? Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
		: undefined;
}

test("snapshot 404 is correlated and sanitized, then retry downloads successfully", async ({
	page,
}) => {
	const snapshotRequests: Array<{
		pathname: string;
		search: string;
		authorization: string | undefined;
	}> = [];
	const otlpSpans: Array<{
		name?: string;
		traceId?: string;
		spanId?: string;
		parentSpanId?: string;
		status?: { code?: number };
		attributes: Record<string, unknown>;
	}> = [];
	let snapshotAttempts = 0;

	await page.route(`**/lix/v1/${REPOSITORY_ID}**`, async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		snapshotRequests.push({
			pathname: url.pathname,
			search: url.search,
			authorization: request.headers().authorization,
		});
		if (url.pathname !== `/lix/v1/${REPOSITORY_ID}/snapshot`) {
			await route.fulfill({ status: 404, body: "Unexpected protocol handshake" });
			return;
		}
		snapshotAttempts += 1;
		if (snapshotAttempts === 1) {
			await route.fulfill({
				status: 404,
				headers: { "x-request-id": "snapshot_req_404" },
				body: BODY_SECRET,
			});
			return;
		}
		await route.fulfill({
			status: 200,
			headers: { "content-type": "application/vnd.lix.snapshot" },
			body: Buffer.from("LIXSNAP-retry-success"),
		});
	});
	await page.route("**/api/telemetry/browser/otlp/v1/traces", async (route) => {
		const request = route.request();
		if (request.method() === "POST") {
			let body = request.postDataBuffer() ?? Buffer.alloc(0);
			if (request.headers()["content-encoding"] === "gzip")
				body = gunzipSync(body);
			if (body.byteLength > 0) {
				const decoded = traceRequestType.decode(body) as {
					resourceSpans?: Array<{
						scopeSpans?: Array<{
							spans?: Array<{
								name?: string;
								traceId?: Uint8Array;
								spanId?: Uint8Array;
								parentSpanId?: Uint8Array;
								status?: { code?: number };
								attributes?: Array<{
									key?: string;
									value?: Record<string, unknown>;
								}>;
							}>;
						}>;
					}>;
				};
				for (const resource of decoded.resourceSpans ?? []) {
					for (const scope of resource.scopeSpans ?? []) {
						for (const span of scope.spans ?? []) {
							otlpSpans.push({
								name: span.name,
								traceId: hex(span.traceId),
								spanId: hex(span.spanId),
								parentSpanId: hex(span.parentSpanId),
								status: span.status,
								attributes: flattenAttributes(span.attributes),
							});
						}
					}
				}
			}
		}
		await route.fulfill({
			status: 200,
			contentType: "application/x-protobuf",
			body: Buffer.alloc(0),
		});
	});

	// SDK-shaped exception records are passed through the same before-send
	// callback. The local receiver below captures OTLP spans; this does not claim
	// a live PostHog ingestion request.
	await page.goto("/snapshot.html");
	await page.getByRole("button", { name: "Download remote snapshot" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Remote Lix snapshot request failed with status 404",
	);
	await expect(page.getByTestId("snapshot-status")).toHaveText("Download failed");

	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & {
						snapshotEvents: Array<{ event: string; properties: Record<string, unknown> }>;
					}).snapshotEvents.length,
			),
		)
		.toBe(2);
	await expect
		.poll(() => {
			return page.evaluate(
				() =>
					(window as Window & {
						snapshotEvents: Array<{ event: string; properties: Record<string, unknown> }>;
					}).snapshotEvents.filter(
						({ event, properties }) =>
							event === "repository_snapshot_download" &&
							properties.outcome === "started",
					).length,
			);
		})
		.toBe(1);
	await expect
		.poll(() => {
			return page.evaluate(
				() =>
					(window as Window & {
						snapshotEvents: Array<{ event: string; properties: Record<string, unknown> }>;
					}).snapshotEvents.filter(
						({ event, properties }) =>
							event === "repository_snapshot_download" &&
							properties.outcome === "failed",
					).length,
			);
		})
		.toBe(1);
	await expect
		.poll(() => otlpSpans.filter(({ name }) => name === "repository.snapshot.download").length)
		.toBe(1);

	const recorded = await page.evaluate(
		() =>
			(window as Window & {
				snapshotEvents: Array<{ event: string; properties: Record<string, unknown> }>;
				snapshotExceptions: Array<{ name: string; message: string; properties: Record<string, unknown> }>;
			}).snapshotEvents,
	);
	const exceptions = await page.evaluate(
		() =>
			(window as Window & {
				snapshotExceptions: Array<{ name: string; message: string; properties: Record<string, unknown> }>;
			}).snapshotExceptions,
	);
	const failedEvents = recorded.filter(
		({ event, properties }) =>
			event === "repository_snapshot_download" &&
			(properties.outcome === "started" || properties.outcome === "failed"),
	);
	expect(failedEvents).toHaveLength(2);
	const started = failedEvents.find(({ properties }) => properties.outcome === "started")!;
	const failed = failedEvents.find(({ properties }) => properties.outcome === "failed")!;
	const startedProperties = started.properties!;
	const failedProperties = failed.properties!;
	expect(startedProperties.snapshot_attempt_id).toEqual(
		failedProperties.snapshot_attempt_id,
	);
	expect(startedProperties.$otel_trace_id).toEqual(failedProperties.$otel_trace_id);
	expect(startedProperties.$otel_span_id).toEqual(failedProperties.$otel_span_id);
	expect(failedProperties.failure_stage).toBe("http_response");
	expect(failedProperties.lix_http_status).toBe(404);
	expect(failedProperties.httpStatus).toBe(404);
	expect(failedProperties.request_id).toBe("snapshot_req_404");
	expect(failedProperties.reproduction).toEqual({
		action: "download_remote_snapshot",
		repository_id: REPOSITORY_ID,
		method: "GET",
		endpoint: "/lix/v1/{lix_id}/snapshot",
	});
	expect(JSON.stringify([startedProperties, failedProperties])).not.toContain(
		AUTH_SECRET,
	);
	expect(JSON.stringify([startedProperties, failedProperties])).not.toContain(
		QUERY_SECRET,
	);
	expect(JSON.stringify([startedProperties, failedProperties])).not.toContain(
		BODY_SECRET,
	);
	expect(JSON.stringify([startedProperties, failedProperties])).not.toContain(
		"download_secret",
	);
	expect(exceptions).toHaveLength(1);
	expect(exceptions[0]).toMatchObject({
		name: "RepositorySnapshotDownloadError",
		message: "Remote snapshot download failed (http_response, HTTP 404)",
	});
	expect(JSON.stringify(exceptions)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(exceptions)).not.toContain(QUERY_SECRET);
	expect(JSON.stringify(exceptions)).not.toContain(BODY_SECRET);

	await expect.poll(() => snapshotRequests.length).toBe(1);
	expect(snapshotRequests[0]).toMatchObject({
		pathname: `/lix/v1/${REPOSITORY_ID}/snapshot`,
		search: "?download_secret=snapshot-fixture-query-secret",
		authorization: `Bearer ${AUTH_SECRET}`,
	});

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Retry snapshot download" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("remote-snapshot.lixsnap");
	const stream = await download.createReadStream();
	if (!stream) throw new Error("The snapshot download stream was unavailable");
	const chunks: string[] = [];
	for await (const chunk of stream) chunks.push(String(chunk));
	expect(chunks.join("")).toBe("LIXSNAP-retry-success");
	await expect(page.getByTestId("snapshot-status")).toHaveText(
		"Downloaded 21 bytes",
	);

	await page.evaluate(() =>
		(
			window as Window & {
				runExceptionTraceability: () => Promise<void>;
			}
		).runExceptionTraceability(),
	);

	const traceability = await page.evaluate(() => {
		const typedWindow = window as Window & {
			snapshotPreparedExceptions: Array<{
				event: string;
				properties: Record<string, unknown>;
			}>;
			snapshotExpectedTraces: Record<string, { traceId: string; spanId: string }>;
		};
		return {
			prepared: typedWindow.snapshotPreparedExceptions,
			expected: typedWindow.snapshotExpectedTraces,
		};
	});
	const activeProperties = traceability.prepared[0].properties;
	expect(activeProperties.operation).toBe("snapshot.fixture.handled");
	expect(activeProperties.error_correlation).toBe("active_trace");
	expect(activeProperties.$otel_trace_id).toBe(
		traceability.expected.handled.traceId,
	);
	expect(activeProperties.$otel_span_id).toBe(
		traceability.expected.handled.spanId,
	);
	expect(activeProperties.service_name).toBe("lixray-web");
	expect(activeProperties.client_release).toBe("snapshot-fixture-release");
	expect(activeProperties.error_id).toMatch(
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
	);
	expect(JSON.stringify(activeProperties)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(activeProperties)).not.toContain(BODY_SECRET);

	const invalidPairProperties = traceability.prepared[1].properties;
	expect(invalidPairProperties.error_correlation).toBe("active_trace");
	expect(invalidPairProperties.$otel_trace_id).toBe(
		traceability.expected.invalidPair.traceId,
	);
	expect(invalidPairProperties.$otel_span_id).toBe(
		traceability.expected.invalidPair.spanId,
	);
	expect(invalidPairProperties.error_id).toMatch(
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
	);
	expect(invalidPairProperties.error_id).not.toBe("not-an-error-id");
	const exceptionList = invalidPairProperties.$exception_list as Array<{
		stacktrace?: { frames?: Array<Record<string, unknown>> };
	}>;
	expect(exceptionList[0]?.stacktrace?.frames?.[0]).not.toHaveProperty("vars");
	expect(JSON.stringify(invalidPairProperties)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(invalidPairProperties)).not.toContain(BODY_SECRET);
	expect(JSON.stringify(invalidPairProperties)).not.toContain("/private/");

	const standaloneProperties = traceability.prepared[2].properties;
	expect(standaloneProperties.operation).toBe("snapshot.fixture.standalone");
	expect(standaloneProperties.error_correlation).toBe("standalone_trace");
	expect(standaloneProperties.service_name).toBe("lixray-web");
	expect(standaloneProperties.client_release).toBe("snapshot-fixture-release");
	expect(standaloneProperties.error_id).toMatch(
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
	);

	const automatic = traceability.prepared.slice(3);
	expect(automatic).toHaveLength(2);
	expect(
		(automatic[0].properties.$exception_list as Array<{ mechanism?: { type?: string } }>)[0]
			?.mechanism?.type,
	).toBe("onerror");
	expect(
		(automatic[1].properties.$exception_list as Array<{ mechanism?: { type?: string } }>)[0]
			?.mechanism?.type,
	).toBe("unhandledrejection");
	for (const { properties } of automatic) {
		expect(properties).toMatchObject({
			error_correlation: "standalone_trace",
			service_name: "lixray-web",
			client_release: "snapshot-fixture-release",
		});
		expect(properties.operation).toBe("browser.exception");
		expect(properties?.error_id).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
		);
	}
	const standaloneExceptions = [
		standaloneProperties,
		...automatic.map(({ properties }) => properties),
	];
	await expect
		.poll(() =>
			standaloneExceptions.every((properties) =>
				otlpSpans.some(
					({ name, traceId, spanId, attributes }) =>
						name === properties.operation &&
						traceId === properties.$otel_trace_id &&
						spanId === properties.$otel_span_id &&
						attributes["exception.capture_id"] === properties.error_id,
				),
			),
		)
		.toBe(true);
	for (const properties of standaloneExceptions) {
		const exceptionTrace = otlpSpans.find(
			({ name, traceId, spanId, attributes }) =>
				name === properties.operation &&
				traceId === properties?.$otel_trace_id &&
				spanId === properties?.$otel_span_id &&
				attributes["exception.capture_id"] === properties?.error_id,
		);
		expect(exceptionTrace).toBeDefined();
		expect(exceptionTrace?.status?.code).toBe(2);
	}

	const trace = otlpSpans.find(
		({ name }) => name === "repository.snapshot.download",
	)!;
	const httpTrace = otlpSpans.find(
		({ name, attributes }) =>
			name === "lix.client.rpc" &&
			attributes["http.response.status_code"] === 404,
	)!;
	expect(trace.attributes["snapshot.failure_stage"]).toBe("http_response");
	expect(trace.attributes["http.response.status_code"]).toBe(404);
	expect(trace.traceId).toBe(failedProperties.$otel_trace_id);
	expect(trace.spanId).toBe(failedProperties.$otel_span_id);
	expect(httpTrace.parentSpanId).toBe(trace.spanId);
	expect(httpTrace.traceId).toBe(trace.traceId);
	expect(httpTrace.attributes["http.route"]).toBe(
		"/lix/v1/{lix_id}/snapshot",
	);
	expect(httpTrace.attributes["http.response.status_code"]).toBe(404);
	expect(trace.status?.code).toBe(2);
	expect(JSON.stringify(trace)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(trace)).not.toContain(QUERY_SECRET);
	expect(JSON.stringify(trace)).not.toContain(BODY_SECRET);
	expect(JSON.stringify(httpTrace)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(httpTrace)).not.toContain(QUERY_SECRET);
	expect(JSON.stringify(httpTrace)).not.toContain(BODY_SECRET);
});
