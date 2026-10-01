import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BatchSpanProcessor,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { createRepositoryOpenTrace } from "../../src/lib/repository-open-performance.ts";

const REPOSITORY_ID = "123e4567-e89b-12d3-a456-426614174000";
const openSpanExporter = new InMemorySpanExporter();
const otlpExporter = new OTLPTraceExporter({
	url: new URL("/__fixture/otlp/v1/traces", window.location.origin).toString(),
	timeoutMillis: 5_000,
});
const provider = new WebTracerProvider({
	resource: resourceFromAttributes({
		"service.name": "repository-opening-fixture",
	}),
	spanProcessors: [
		new SimpleSpanProcessor(openSpanExporter),
		new BatchSpanProcessor(otlpExporter, {
			scheduledDelayMillis: 60_000,
			exportTimeoutMillis: 5_000,
		}),
	],
});
provider.register();

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

window.runRepositoryOpeningFixture = async () => {
	const tracer = provider.getTracer("repository-opening-fixture");
	const controller = createRepositoryOpenTrace(tracer, () => performance.now());
	const startTime = Math.max(1, performance.now());
	controller.begin("fixture-repository", startTime);
	controller.mount();
	controller.attempt(REPOSITORY_ID);
	const recorder = controller.recorder(REPOSITORY_ID);
	if (!recorder) throw new Error("Repository open recorder was unavailable");

	const { openLix } = await import("@lix-js/sdk");
	recorder.engineAttempt();
	const lix = await openLix({
		onProgress: (progress) => recorder.progress(progress),
	});
	const report = lix.openReport;
	const resourceResponse = await fetch(
		"/api/repository-open-profile-resource?private=wire-test-secret",
		{ cache: "no-store" },
	);
	if (!resourceResponse.ok)
		throw new Error("Repository open timing resource did not load");
	await resourceResponse.arrayBuffer();
	recorder.opened(report, "partial_replica");
	controller.phase("initial_view", REPOSITORY_ID);

	controller.usable(REPOSITORY_ID);
	let openSpanCountAfterFirstPaint = -1;
	let openSpanCountAfterSecondPaint = -1;
	await new Promise<void>((resolve) => {
		requestAnimationFrame(() => {
			openSpanCountAfterFirstPaint = openSpanExporter
				.getFinishedSpans()
				.filter((span) => span.name === "lixray.repository.open").length;
			requestAnimationFrame(() => {
				openSpanCountAfterSecondPaint = openSpanExporter
					.getFinishedSpans()
					.filter((span) => span.name === "lixray.repository.open").length;
				resolve();
			});
		});
	});
	await provider.forceFlush();
	await lix.close();
	return {
		initialized: report.initialized,
		resourceResponseStatus: resourceResponse.status,
		openSpanCountAfterFirstPaint,
		openSpanCountAfterSecondPaint,
	};
};
