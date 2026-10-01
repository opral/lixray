import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	configureBrowserTelemetryRepository,
	installBrowserTelemetry,
} from "../../src/browser-telemetry";
import {
	exceptionTraceability,
	preparePostHogEvent,
} from "../../src/lib/exception-traceability.ts";
import { downloadRepositorySnapshot } from "../../src/lib/repository-snapshot-telemetry";
import { downloadRepositoryRemoteSnapshot } from "../../src/lib/repository-lix-session";
import { tracer } from "../../src/telemetry.ts";
import type { Properties } from "posthog-js";
import type { ProductEvent } from "../../src/lib/telemetry-events";

const REPOSITORY_ID = "123e4567-e89b-12d3-a456-426614174000";
const ACCESS_TOKEN = "snapshot-fixture-auth-secret";

type SnapshotEvent = { event: ProductEvent; properties: Properties };
type SnapshotException = {
	name: string;
	message: string;
	properties: Properties;
};
type TraceContext = { traceId: string; spanId: string };
type PreparedException = {
	event: string;
	properties: Record<string, unknown>;
};

declare global {
	interface Window {
		snapshotEvents: SnapshotEvent[];
		snapshotExceptions: SnapshotException[];
		snapshotPreparedExceptions: PreparedException[];
		snapshotExpectedTraces: Record<string, TraceContext>;
		runExceptionTraceability: () => Promise<void>;
	}
}

installBrowserTelemetry();
configureBrowserTelemetryRepository(REPOSITORY_ID, async () => ACCESS_TOKEN);
window.snapshotEvents = [];
window.snapshotExceptions = [];
window.snapshotPreparedExceptions = [];
window.snapshotExpectedTraces = {};

window.runExceptionTraceability = async () => {
	tracer.startActiveSpan("snapshot.fixture.handled", (span) => {
		window.snapshotExpectedTraces.handled = span.spanContext();
		const event = preparePostHogEvent({
			uuid: "fixture-handled-active",
			event: "$exception",
			properties: {
				operation: "snapshot.fixture.handled",
				document_content: "snapshot-fixture-private-response-body",
				access_token: "snapshot-fixture-auth-secret",
				$exception_list: [
					{
						type: "Error",
						value: "Handled fixture failure",
						mechanism: { handled: true, type: "handled" },
					},
				],
			},
		});
		window.snapshotPreparedExceptions.push(
			structuredClone(event) as PreparedException,
		);
		span.end();
	});

	tracer.startActiveSpan("snapshot.fixture.invalid_pair", (span) => {
		window.snapshotExpectedTraces.invalidPair = span.spanContext();
		const event = preparePostHogEvent({
			uuid: "fixture-invalid-pair",
			event: "$exception",
			properties: {
				operation: "snapshot.fixture.invalid_pair",
				$otel_trace_id: "invalid-trace-id",
				$otel_span_id: "0000000000000000",
				error_id: "not-an-error-id",
				document_content: "snapshot-fixture-private-response-body",
				$exception_list: [
					{
						type: "Error",
						value: "Bearer snapshot-fixture-auth-secret",
						mechanism: { handled: false, type: "onerror" },
						stacktrace: {
							frames: [
								{
									filename: "file:///private/snapshot-fixture-secret.ts",
									vars: {
										document_content:
										"snapshot-fixture-private-response-body",
									},
								},
							],
						},
					},
				],
			},
		});
		window.snapshotPreparedExceptions.push(
			structuredClone(event) as PreparedException,
		);
		span.end();
	});

	const standalone = preparePostHogEvent({
		uuid: "fixture-standalone",
		event: "$exception",
		properties: {
			operation: "snapshot.fixture.standalone",
			$exception_list: [
				{
				type: "Error",
				value: "Standalone fixture failure",
				mechanism: { handled: false, type: "unhandledrejection" },
			},
			],
		},
	});
	window.snapshotPreparedExceptions.push(
		structuredClone(standalone) as PreparedException,
	);

	for (const [key, kind, message] of [
		["uncaught", "onerror", "Uncaught fixture failure"],
		["unhandledRejection", "unhandledrejection", "Unhandled rejection fixture failure"],
	] as const) {
		const exception = preparePostHogEvent({
			uuid: `fixture-${key}`,
			event: "$exception",
			properties: {
				$exception_list: [
					{
						type: "Error",
						value: message,
						mechanism: { handled: false, type: kind },
					},
				],
			},
		});
		window.snapshotPreparedExceptions.push(
			structuredClone(exception) as PreparedException,
		);
	}
};

function SnapshotFixture() {
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState("Ready");
	const [attempt, setAttempt] = useState(0);

	const download = async () => {
		setError(null);
		setStatus("Downloading");
		setAttempt((value) => value + 1);
		try {
			const blob = await downloadRepositorySnapshot(
				() =>
					downloadRepositoryRemoteSnapshot({
						namespace: "snapshot-fixture",
						repositorySlug: "fixture",
						repositoryId: REPOSITORY_ID,
						origin: window.location.origin,
						getAccessToken: async () => ACCESS_TOKEN,
						refreshAccessToken: async () => ACCESS_TOKEN,
						authIdentity: "snapshot-fixture",
						fetch: (input, init) => {
							const request = new Request(input, init);
							const url = new URL(request.url);
							url.searchParams.set("download_secret", "snapshot-fixture-query-secret");
							return window.fetch(new Request(url, request));
						},
					}),
				REPOSITORY_ID,
				(error, properties) => {
					const traceable = exceptionTraceability(properties ?? {});
					window.snapshotExceptions.push({
						name: error instanceof Error ? error.name : "UnknownError",
						message: error instanceof Error ? error.message : "",
						properties: structuredClone(traceable),
					});
				},
				(event, properties) => {
					window.snapshotEvents.push({
						event: event as ProductEvent,
						properties: structuredClone(properties ?? {}),
					});
				},
			);
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = "remote-snapshot.lixsnap";
			anchor.click();
			setStatus(`Downloaded ${blob.size} bytes`);
			window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
		} catch (caught) {
			const message =
				caught instanceof Error ? caught.message : "Snapshot download failed";
			setError(message);
			setStatus("Download failed");
		}
	};

	return (
		<main>
			<h1>Remote snapshot download</h1>
			<p role="status" data-testid="snapshot-status">
				{status}
			</p>
			{error ? <p role="alert">{error}</p> : null}
			<button type="button" onClick={() => void download()}>
				{attempt === 0 ? "Download remote snapshot" : "Retry snapshot download"}
			</button>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<SnapshotFixture />);
