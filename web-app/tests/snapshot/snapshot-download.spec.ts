import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "../../src/worker/otlp-traces.schema.json" with { type: "json" };
import { expect, test, type Route } from "@playwright/test";

const REPOSITORY_ID = "123e4567-e89b-12d3-a456-426614174000";
const AUTH_SECRET = "snapshot-fixture-auth-secret";
const QUERY_SECRET = "snapshot-fixture-query-secret";
const BODY_SECRET = "snapshot-fixture-private-response-body";
const traceRequestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

type PostHogWireEvent = {
	event?: string;
	properties?: Record<string, unknown>;
};

function decodePostHogCaptureRequest(route: Route): PostHogWireEvent[] {
	const request = route.request();
	const body = request.postDataBuffer() ?? Buffer.alloc(0);
	const candidates = [body];
	if (body[0] === 0x1f && body[1] === 0x8b) {
		candidates.unshift(gunzipSync(body));
	}
	const bodyText = body.toString("utf8");
	if (/^[A-Za-z0-9+/]+=*$/.test(bodyText)) {
		const base64 = Buffer.from(bodyText, "base64");
		if (base64[0] === 0x1f && base64[1] === 0x8b)
			candidates.unshift(gunzipSync(base64));
	}
	for (const candidate of candidates) {
		try {
			const payload: unknown = JSON.parse(candidate.toString("utf8"));
			if (Array.isArray(payload)) return payload as PostHogWireEvent[];
			if (!payload || typeof payload !== "object") continue;
			const record = payload as {
				batch?: unknown;
				events?: unknown;
				event?: unknown;
				properties?: unknown;
			};
			if (Array.isArray(record.batch))
				return record.batch as PostHogWireEvent[];
			if (Array.isArray(record.events))
				return record.events as PostHogWireEvent[];
			if (typeof record.event === "string" && record.properties)
				return [record as PostHogWireEvent];
		} catch {
			// Try the next supported wire encoding without retaining the raw body.
		}
	}
	throw new Error(
		"PostHog capture request did not contain a readable JSON payload",
	);
}

function firstException(event: PostHogWireEvent) {
	const exceptions = event.properties?.$exception_list;
	return Array.isArray(exceptions) &&
		exceptions[0] &&
		typeof exceptions[0] === "object"
		? (exceptions[0] as Record<string, unknown>)
		: undefined;
}

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
	const posthogWireEvents: PostHogWireEvent[] = [];
	const posthogCaptureRequests: Array<{
		method: string;
		path: string;
		eventCount: number;
		status: number;
	}> = [];
	const externalRequests: Array<{ host: string; path: string }> = [];
	const posthogTraffic: string[] = [];
	const fixtureOrigin = `http://127.0.0.1:${process.env.LIXRAY_SNAPSHOT_PORT ?? 8796}`;
	let snapshotAttempts = 0;
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			request.method() === "POST" &&
			/\/(?:i\/v\d+\/e|e|flags|decide|array|v1\/traces)(?:\/|$)/u.test(
				url.pathname,
			)
		) {
			posthogTraffic.push(
				`${url.hostname}${url.pathname.replace(/\/array\/[^/]+\/config\.js$/u, "/array/:token/config.js")}`,
			);
		}
	});

	await page.route(`**/lix/v1/${REPOSITORY_ID}**`, async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		snapshotRequests.push({
			pathname: url.pathname,
			search: url.search,
			authorization: request.headers().authorization,
		});
		if (url.pathname !== `/lix/v1/${REPOSITORY_ID}/snapshot`) {
			await route.fulfill({
				status: 404,
				body: "Unexpected protocol handshake",
			});
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
	await page.route("https://**/*", async (route) => {
		const url = new URL(route.request().url());
		externalRequests.push({
			host: url.hostname,
			path: url.pathname.replace(
				/\/array\/[^/]+\/config\.js$/u,
				"/array/:token/config.js",
			),
		});
		await route.abort();
	});
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			request.method() === "POST" &&
			url.origin === fixtureOrigin &&
			/\/(?:i\/v\d+\/e|e)\/?$/u.test(url.pathname)
		) {
			const events = decodePostHogCaptureRequest(route).map(
				({ event, properties }) => ({
					event,
					properties,
				}),
			);
			posthogWireEvents.push(...events);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ status: "Ok" }),
			});
			posthogCaptureRequests.push({
				method: request.method(),
				path: url.pathname,
				eventCount: events.length,
				status: 200,
			});
			return;
		}
		await route.fallback();
	});

	// The fixture initializes the installed full.no-external PostHog SDK against
	// this local receiver and preserves the application's before_send callback.
	await page.goto("/snapshot.html");
	await page.getByRole("button", { name: "Download remote snapshot" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Remote Lix snapshot request failed with status 404",
	);
	await expect(page.getByTestId("snapshot-status")).toHaveText(
		"Download failed",
	);

	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(
						window as Window & {
							snapshotEvents: Array<{
								event: string;
								properties: Record<string, unknown>;
							}>;
						}
					).snapshotEvents.length,
			),
		)
		.toBe(2);
	await expect
		.poll(() => {
			return page.evaluate(
				() =>
					(
						window as Window & {
							snapshotEvents: Array<{
								event: string;
								properties: Record<string, unknown>;
							}>;
						}
					).snapshotEvents.filter(
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
					(
						window as Window & {
							snapshotEvents: Array<{
								event: string;
								properties: Record<string, unknown>;
							}>;
						}
					).snapshotEvents.filter(
						({ event, properties }) =>
							event === "repository_snapshot_download" &&
							properties.outcome === "failed",
					).length,
			);
		})
		.toBe(1);
	await expect
		.poll(
			() =>
				otlpSpans.filter(({ name }) => name === "repository.snapshot.download")
					.length,
		)
		.toBe(1);

	const recorded = await page.evaluate(
		() =>
			(
				window as Window & {
					snapshotEvents: Array<{
						event: string;
						properties: Record<string, unknown>;
					}>;
					snapshotExceptions: Array<{
						name: string;
						message: string;
						properties: Record<string, unknown>;
					}>;
				}
			).snapshotEvents,
	);
	const exceptions = await page.evaluate(
		() =>
			(
				window as Window & {
					snapshotExceptions: Array<{
						name: string;
						message: string;
						properties: Record<string, unknown>;
					}>;
				}
			).snapshotExceptions,
	);
	const failedEvents = recorded.filter(
		({ event, properties }) =>
			event === "repository_snapshot_download" &&
			(properties.outcome === "started" || properties.outcome === "failed"),
	);
	expect(failedEvents).toHaveLength(2);
	const started = failedEvents.find(
		({ properties }) => properties.outcome === "started",
	)!;
	const failed = failedEvents.find(
		({ properties }) => properties.outcome === "failed",
	)!;
	const startedProperties = started.properties!;
	const failedProperties = failed.properties!;
	expect(startedProperties.snapshot_attempt_id).toEqual(
		failedProperties.snapshot_attempt_id,
	);
	expect(startedProperties.$otel_trace_id).toEqual(
		failedProperties.$otel_trace_id,
	);
	expect(startedProperties.$otel_span_id).toEqual(
		failedProperties.$otel_span_id,
	);
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
				triggerPostHogWireExceptions: () => void;
			}
		).triggerPostHogWireExceptions(),
	);
	await expect
		.poll(
			() =>
				posthogWireEvents.filter(({ event }) => event === "$exception").length,
		)
		.toBeGreaterThanOrEqual(3);
	expect(posthogCaptureRequests.length).toBeGreaterThan(0);
	expect(posthogCaptureRequests.every(({ status }) => status === 200)).toBe(
		true,
	);
	expect(externalRequests).toEqual([]);
	const posthogStatus = await page.evaluate(() => {
		const testWindow = window as Window & {
			snapshotPostHogStatus: () => Record<string, unknown> & {
				beforeSendEvents: string[];
			};
			snapshotPostHogCaptureExceptionCalls: number;
		};
		return {
			...testWindow.snapshotPostHogStatus(),
			captureExceptionCalls: testWindow.snapshotPostHogCaptureExceptionCalls,
		};
	});
	expect(posthogStatus).toMatchObject({
		loaded: true,
		tokenPresent: true,
		apiHost: fixtureOrigin,
		captureDisabled: false,
		optedOut: false,
		optedIn: true,
		beforeSendPresent: true,
		optOutUserAgentFilter: true,
		captureUnhandledErrors: true,
		captureUnhandledRejections: true,
		captureExceptionCalls: 1,
	});
	expect(posthogStatus.beforeSendEvents).toContain("$exception");

	const wireExceptions = posthogWireEvents.filter(
		(event) => event.event === "$exception",
	);
	const wireExceptionSummary = wireExceptions.map((event) => {
		const exception = firstException(event);
		const mechanism = exception?.mechanism as
			| { handled?: boolean; type?: string }
			| undefined;
		return {
			errorType: exception?.type,
			operation: event.properties?.operation,
			mechanism: mechanism?.type,
			handled: mechanism?.handled,
		};
	});
	expect(
		wireExceptions,
		JSON.stringify({ posthogStatus, posthogTraffic, wireExceptionSummary }),
	).toHaveLength(3);
	const handledWireException = wireExceptions.find(
		(event) =>
			event.properties?.operation === "repository_remote_snapshot_download",
	);
	expect(handledWireException).toBeDefined();
	const handledWireProperties = handledWireException!.properties!;
	const handledWireError = firstException(handledWireException!);
	expect(handledWireError?.type).toBe("RepositorySnapshotDownloadError");
	expect(handledWireError?.value).toBe(
		"Remote snapshot download failed (http_response, HTTP 404)",
	);
	expect(handledWireProperties).toMatchObject({
		operation: "repository_remote_snapshot_download",
		service_name: "lixray-web",
		client_release: "snapshot-fixture-release",
		failure_stage: "http_response",
		lix_http_status: 404,
		httpStatus: 404,
		request_id: "snapshot_req_404",
		reproduction: {
			action: "download_remote_snapshot",
			repository_id: REPOSITORY_ID,
			method: "GET",
			endpoint: "/lix/v1/{lix_id}/snapshot",
		},
	});
	expect(handledWireProperties.error_id).toMatch(
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
	);
	expect(handledWireProperties.error_correlation).toBe("provided_trace");
	expect(handledWireProperties.$otel_trace_id).toBe(
		failedProperties.$otel_trace_id,
	);
	expect(handledWireProperties.$otel_span_id).toBe(
		failedProperties.$otel_span_id,
	);

	const uncaughtWireException = wireExceptions.find(
		(event) => firstException(event)?.type === "SnapshotFixtureUncaughtError",
	);
	const rejectionWireException = wireExceptions.find(
		(event) => firstException(event)?.type === "SnapshotFixtureRejectionError",
	);
	expect(uncaughtWireException).toBeDefined();
	const unhandledRejectionEvents = await page.evaluate(
		() =>
			(
				window as Window & {
					snapshotUnhandledRejectionEvents: Array<{
						isTrusted: boolean;
						reasonType: string;
					}>;
				}
			).snapshotUnhandledRejectionEvents,
	);
	expect(
		rejectionWireException,
		JSON.stringify({ wireExceptionSummary, unhandledRejectionEvents }),
	).toBeDefined();
	expect(unhandledRejectionEvents).toEqual([
		{ isTrusted: false, reasonType: "SnapshotFixtureRejectionError" },
	]);
	for (const event of [uncaughtWireException!, rejectionWireException!]) {
		const properties = event.properties!;
		const exception = firstException(event);
		const mechanism = exception?.mechanism as
			| { handled?: boolean; type?: string }
			| undefined;
		expect(properties).toMatchObject({
			operation: "browser.exception",
			error_correlation: "standalone_trace",
			service_name: "lixray-web",
			client_release: "snapshot-fixture-release",
		});
		expect(properties.error_id).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
		);
		expect(properties.$otel_trace_id).toMatch(/^[a-f0-9]{32}$/);
		expect(properties.$otel_span_id).toMatch(/^[a-f0-9]{16}$/);
		expect(mechanism).toMatchObject({ handled: false });
		await expect
			.poll(() =>
				otlpSpans.some(
					({ name, traceId, spanId, attributes }) =>
						name === "browser.exception" &&
						traceId === properties.$otel_trace_id &&
						spanId === properties.$otel_span_id &&
						attributes["exception.capture_id"] === properties.error_id,
				),
			)
			.toBe(true);
	}
	expect(JSON.stringify(wireExceptions)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(wireExceptions)).not.toContain(QUERY_SECRET);
	expect(JSON.stringify(wireExceptions)).not.toContain(BODY_SECRET);
	expect(JSON.stringify(wireExceptions)).not.toContain("download_secret");

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
			snapshotExpectedTraces: Record<
				string,
				{ traceId: string; spanId: string }
			>;
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
		(
			automatic[0].properties.$exception_list as Array<{
				mechanism?: { type?: string };
			}>
		)[0]?.mechanism?.type,
	).toBe("onerror");
	expect(
		(
			automatic[1].properties.$exception_list as Array<{
				mechanism?: { type?: string };
			}>
		)[0]?.mechanism?.type,
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
	expect(httpTrace.attributes["http.route"]).toBe("/lix/v1/{lix_id}/snapshot");
	expect(httpTrace.attributes["http.response.status_code"]).toBe(404);
	expect(trace.status?.code).toBe(2);
	expect(JSON.stringify(trace)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(trace)).not.toContain(QUERY_SECRET);
	expect(JSON.stringify(trace)).not.toContain(BODY_SECRET);
	expect(JSON.stringify(httpTrace)).not.toContain(AUTH_SECRET);
	expect(JSON.stringify(httpTrace)).not.toContain(QUERY_SECRET);
	expect(JSON.stringify(httpTrace)).not.toContain(BODY_SECRET);
});
