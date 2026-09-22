import { randomUUID } from "node:crypto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

/** One provider per process. Export is bounded and never awaited by a request. */
export function initializeTelemetry(env = process.env) {
	const demo =
		env.LIXRAY_DEMO === "1" ||
		/^(lixray-pr-[0-9]+|pr-[a-z0-9]+-[0-9]+)$/.test(
			env.RAILWAY_ENVIRONMENT_NAME ?? "",
		);
	const enabled =
		!demo &&
		env.POSTHOG_ENVIRONMENT === "production" &&
		env.POSTHOG_PROJECT_TOKEN;
	const processors = enabled
		? [
				new BatchSpanProcessor(
					new OTLPTraceExporter({
						url: new URL(
							"/i/v1/traces",
							env.POSTHOG_HOST ?? "https://us.i.posthog.com",
						).href,
						headers: { authorization: `Bearer ${env.POSTHOG_PROJECT_TOKEN}` },
						timeoutMillis: 4000,
					}),
					{
						maxQueueSize: 2048,
						maxExportBatchSize: 256,
						scheduledDelayMillis: 1000,
						exportTimeoutMillis: 5000,
					},
				),
			]
		: [];
	const provider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			"service.name": "lixray",
			"service.version":
				env.RAILWAY_GIT_COMMIT_SHA ?? env.LIXRAY_RELEASE_ID ?? "development",
			"service.instance.id": env.RAILWAY_REPLICA_ID ?? randomUUID(),
			"vcs.ref.head.revision":
				env.RAILWAY_GIT_COMMIT_SHA ?? env.LIXRAY_RELEASE_ID ?? "unknown",
			"deployment.environment.name":
				env.RAILWAY_ENVIRONMENT_NAME ??
				env.POSTHOG_ENVIRONMENT ??
				"development",
		}),
		spanProcessors: processors,
	});
	provider.register({ propagator: new W3CTraceContextPropagator() });
	return provider;
}
