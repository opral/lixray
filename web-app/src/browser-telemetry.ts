import { createRepositorySpanExporter } from "./lib/repository-span-exporter.ts";
import { context, propagation, type Context } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import protobuf from "protobufjs/light.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import type { LixTelemetryOptions } from "@lix-js/sdk";
import { isDemoModeEnabled } from "./lib/demo-client.ts";
import schema from "./worker/otlp-traces.schema.json" with { type: "json" };

const OTLP_PATH = "/api/telemetry/browser/otlp/v1/traces";
const MAX_EXPORT_BYTES = 256 * 1024;
const EXPORT_INTERVAL_MS = 250;
const MAX_GATEWAY_BYTES = 4 * 1024 * 1024;
const SERVICE_VERSION =
	typeof import.meta.env === "object"
		? (import.meta.env.VITE_LIXRAY_RELEASE_ID ?? "unknown")
		: "unknown";

type AccessTokenProvider = () => Promise<string | null>;

let accessTokenProvider: AccessTokenProvider = () => Promise.resolve(null);
let repositoryIdProvider: () => string | null = () => null;

/** Configure gateway auth before the first browser span can be exported. */
export function configureBrowserTelemetryRepository(
	repositoryId: string,
	getAccessToken: AccessTokenProvider,
): void {
	accessTokenProvider = getAccessToken;
	repositoryIdProvider = () => repositoryId;
}
let providerInstalled = false;
const traceRequestType = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

/** Install the browser SDK before rendering so async UI and repository work share context. */
export function installBrowserTelemetry(): void {
	if (providerInstalled || isDemoModeEnabled || typeof window === "undefined")
		return;
	providerInstalled = true;
	const exporter = createRepositorySpanExporter(
		(repositoryId) =>
			new OTLPTraceExporter({
				url: new URL(OTLP_PATH, window.location.origin).toString(),
				headers: async (): Promise<Record<string, string>> => {
					const token = await accessTokenProvider();

					if (!token || !repositoryId) return {};
					return {
						Authorization: `Bearer ${token}`,
						"x-lixray-repository-id": repositoryId,
					};
				},
				timeoutMillis: 4_000,
			}),
		() => repositoryIdProvider(),
	);
	const provider = new WebTracerProvider({
		resource: resourceFromAttributes({
			"service.name": "lixray-web",
			"service.version": SERVICE_VERSION,
		}),
		spanProcessors: [
			new BatchSpanProcessor(exporter, {
				maxQueueSize: 1_024,
				maxExportBatchSize: 128,
				scheduledDelayMillis: EXPORT_INTERVAL_MS,
				exportTimeoutMillis: 4_000,
			}),
		],
	});
	provider.register({
		contextManager: new ZoneContextManager(),
		propagator: new W3CTraceContextPropagator(),
	});
}

/** Wire SDK-generated spans and engine spans to the same authenticated OTLP gateway. */
export function createLixTelemetryOptions(
	repositoryId: string,
	getAccessToken: AccessTokenProvider,
): LixTelemetryOptions {
	// Demo sessions use a synthetic identity that cannot authenticate with the
	// telemetry gateway. Match the server-side PostHog policy and drop demo spans.
	if (isDemoModeEnabled) {
		return {
			flush: () => Promise.resolve(),
			onExport() {},
			parentContext() {
				return undefined;
			},
		};
	}
	configureBrowserTelemetryRepository(repositoryId, getAccessToken);
	const pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flushing: Promise<boolean> | undefined;
	let retryAttempt = 0;

	const flush = async (): Promise<void> => {
		if (flushing) {
			const delivered = await flushing;
			if (delivered && pending.length > 0) await flush();
			return;
		}
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		if (pending.length === 0) return;
		const requests: Uint8Array[] = [];
		let size = 0;
		for (const request of pending) {
			if (size + request.byteLength > MAX_GATEWAY_BYTES) break;
			requests.push(request);
			size += request.byteLength;
		}
		if (requests.length === 0)
			throw new Error("Lix OTLP request exceeds the gateway payload limit");
		const body = mergeOtlpRequests(requests);
		flushing = (async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 4_000);
			try {
				const token = await awaitWithSignal(
					Promise.resolve().then(getAccessToken),
					controller.signal,
				);
				if (!token)
					throw new Error(
						"No repository token is available for Lix OTLP export",
					);
				const requestBody = new ArrayBuffer(body.byteLength);
				new Uint8Array(requestBody).set(body);
				const response = await fetch(
					new URL(OTLP_PATH, window.location.origin),
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"x-lixray-repository-id": repositoryId,
							"content-type": "application/x-protobuf",
						},
						body: requestBody,
						signal: controller.signal,
					},
				);
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					throw new Error(`Lix OTLP export failed (${response.status})`);
				}
				await response.body?.cancel().catch(() => {});
				pending.splice(0, requests.length);
				pendingBytes = Math.max(0, pendingBytes - size);
				retryAttempt = 0;
				return true;
			} catch (error) {
				console.warn(
					"Lix OTLP export failed; retaining spans for retry",
					error,
				);
				const delay = Math.min(30_000, EXPORT_INTERVAL_MS * 2 ** retryAttempt);
				retryAttempt += 1;
				schedule(delay);
				return false;
			} finally {
				clearTimeout(timeout);
				flushing = undefined;
			}
		})();
		const delivered = await flushing;
		if (delivered && pending.length > 0) await flush();
	};

	const schedule = (delay = EXPORT_INTERVAL_MS) => {
		if (timer === undefined) {
			timer = setTimeout(() => {
				void flush().catch(() => undefined);
			}, delay);
		}
	};

	return {
		flush: () => flush(),
		onExport(request: Uint8Array) {
			if (request.byteLength === 0 || request.byteLength > MAX_GATEWAY_BYTES) {
				console.warn("Dropped invalid Lix OTLP export payload");
				return;
			}
			const stamped = stampLixResource(request, repositoryId);
			if (stamped.byteLength === 0) return;
			if (pendingBytes + stamped.byteLength > MAX_EXPORT_BYTES)
				void flush().catch(() => undefined);
			pending.push(stamped);
			pendingBytes += stamped.byteLength;
			if (pendingBytes >= MAX_EXPORT_BYTES) void flush().catch(() => undefined);
			else schedule();
		},
		parentContext() {
			return lixTelemetryParentContext(context.active());
		},
	};
}

async function awaitWithSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) throw new Error("Lix OTLP export timed out");
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new Error("Lix OTLP export timed out"));
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

export function lixTelemetryParentContext(
	activeContext: Context = context.active(),
) {
	const carrier: Record<string, string> = {};
	propagation.inject(activeContext, carrier, {
		set: (destination, key, value) => {
			destination[key] = value;
		},
	});
	if (!carrier.traceparent) return undefined;
	return {
		traceparent: carrier.traceparent,
		...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
	};
}

export function stampLixResource(
	request: Uint8Array,
	repositoryId: string,
): Uint8Array {
	try {
		const decoded = traceRequestType.decode(request) as {
			resourceSpans?: Array<{
				resource?: { attributes?: Array<{ key: string; value?: unknown }> };
			}>;
		};
		for (const resourceSpan of decoded.resourceSpans ?? []) {
			const resource = (resourceSpan.resource ??= {});
			const attributes = (resource.attributes ??= []);
			setStringAttribute(attributes, "service.name", "lixray-web");
			setStringAttribute(attributes, "service.version", SERVICE_VERSION);
			setStringAttribute(attributes, "lix.id", repositoryId);
		}
		return traceRequestType.encode(decoded).finish();
	} catch {
		console.warn("Dropped invalid Lix OTLP protobuf payload");
		return new Uint8Array();
	}
}

export function mergeOtlpRequests(requests: readonly Uint8Array[]): Uint8Array {
	const size = requests.reduce(
		(total, request) => total + request.byteLength,
		0,
	);
	const merged = new Uint8Array(size);
	let offset = 0;
	for (const request of requests) {
		merged.set(request, offset);
		offset += request.byteLength;
	}
	return merged;
}

function setStringAttribute(
	attributes: Array<{ key: string; value?: unknown }>,
	key: string,
	value: string,
): void {
	const existing = attributes.find((attribute) => attribute.key === key);
	if (existing) existing.value = { stringValue: value };
	else attributes.push({ key, value: { stringValue: value } });
}
