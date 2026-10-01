import { useState } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
	configureBrowserTelemetryRepository,
	installBrowserTelemetry,
} from "../../src/browser-telemetry";
import {
	exceptionTraceability,
	preparePostHogEvent,
} from "../../src/lib/exception-traceability.ts";
import { applicationExceptionFrames } from "../../src/lib/exception-stack-trace.ts";
import { lixErrorTelemetryProperties } from "../../src/lib/telemetry.ts";
import { downloadRepositorySnapshot } from "../../src/lib/repository-snapshot-telemetry";
import { downloadRepositoryRemoteSnapshot } from "../../src/lib/repository-lix-session";
import { tracer } from "../../src/telemetry.ts";
import { BROWSER_EXCEPTION_CAPTURE_CONFIG } from "../../src/lib/telemetry-exceptions.ts";
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
		triggerPostHogWireExceptions: () => Promise<void>;
		snapshotActualWasmSql?: {
			code?: unknown;
			rustOrigin?: unknown;
			frameCandidates: Array<{
				filename: string;
				lineno: number;
				colno: number;
			}>;
		};
		snapshotPostHogCaptureExceptionCalls: number;
		snapshotPostHogBeforeSendCalls: number;
		snapshotPostHogBeforeSendEvents: string[];
		snapshotUnhandledRejectionEvents: Array<{
			isTrusted: boolean;
			reasonType: string;
		}>;
		snapshotPostHogStatus: () => Record<string, unknown> & {
			beforeSendEvents: string[];
		};
	}
}

installBrowserTelemetry();
configureBrowserTelemetryRepository(REPOSITORY_ID, async () => ACCESS_TOKEN);
window.snapshotPostHogCaptureExceptionCalls = 0;
window.snapshotPostHogBeforeSendCalls = 0;
window.snapshotPostHogBeforeSendEvents = [];
window.snapshotUnhandledRejectionEvents = [];
window.addEventListener("unhandledrejection", (event) => {
	window.snapshotUnhandledRejectionEvents.push({
		isTrusted: event.isTrusted,
		reasonType:
			event.reason instanceof Error ? event.reason.name : typeof event.reason,
	});
});
posthog.init("phc_0123456789abcdef0123456789abcdef", {
	api_host: window.location.origin,
	defaults: "2026-05-30",
	advanced_disable_flags: true,
	autocapture: false,
	capture_pageview: false,
	capture_pageleave: false,
	capture_exceptions: BROWSER_EXCEPTION_CAPTURE_CONFIG,
	disable_persistence: true,
	disable_session_recording: true,
	disable_surveys: true,
	opt_out_useragent_filter: true,
	person_profiles: "identified_only",
	request_batching: false,
	before_send: (event) => {
		window.snapshotPostHogBeforeSendCalls += 1;
		window.snapshotPostHogBeforeSendEvents.push(event?.event ?? "null");
		return preparePostHogEvent(event);
	},
});
window.snapshotPostHogStatus = () => {
	const client = posthog as unknown as {
		__loaded?: boolean;
		config: {
			token?: string;
			api_host?: string;
			capture_disabled?: boolean;
			capture_exceptions?: {
				capture_unhandled_errors?: boolean;
				capture_unhandled_rejections?: boolean;
			};
			before_send?: unknown;
			opt_out_useragent_filter?: boolean;
		};
		has_opted_out_capturing: () => boolean;
		has_opted_in_capturing: () => boolean;
	};
	return {
		loaded: client.__loaded === true,
		tokenPresent: Boolean(client.config.token),
		apiHost: client.config.api_host,
		captureDisabled: client.config.capture_disabled ?? false,
		optedOut: client.has_opted_out_capturing(),
		optedIn: client.has_opted_in_capturing(),
		beforeSendPresent: typeof client.config.before_send === "function",
		beforeSendCalls: window.snapshotPostHogBeforeSendCalls,
		beforeSendEvents: [...window.snapshotPostHogBeforeSendEvents],
		unhandledRejectionEvents: [...window.snapshotUnhandledRejectionEvents],
		optOutUserAgentFilter: client.config.opt_out_useragent_filter,
		captureUnhandledErrors:
			client.config.capture_exceptions?.capture_unhandled_errors,
		captureUnhandledRejections:
			client.config.capture_exceptions?.capture_unhandled_rejections,
	};
};
window.snapshotEvents = [];
window.snapshotExceptions = [];
window.snapshotPreparedExceptions = [];
window.snapshotExpectedTraces = {};

window.triggerPostHogWireExceptions = async () => {
	const nativeError = Object.assign(
		new Error(
			"DataFusion failed for /home/private/worktree; SELECT secret FROM private_table",
		),
		{
			name: "LixError",
			code: "LIX_SQL_QUERY_FAILED",
			hint: "SELECT private contents FROM repository_files",
			rustOrigin: {
				kind: "source_location",
				file: "packages/lix/src/query.rs",
				line: 217,
				column: 5,
			},
			rustStacktraceStatus: "not_captured",
		},
	);
	posthog.captureException(
		nativeError,
		exceptionTraceability({
			...lixErrorTelemetryProperties(nativeError),
			operation: "snapshot.fixture.synthetic_native",
		}),
	);
	const { openLix } = await import("@lix-js/sdk");
	const lix = await openLix();
	try {
		let captured = false;
		try {
			await lix.execute("SELECT * FROM telemetry_missing_table");
		} catch (error) {
			captured = true;
			const properties = lixErrorTelemetryProperties(error);
			const errorFields =
				error && typeof error === "object"
					? (error as { name?: unknown; message?: unknown; stack?: unknown })
					: {};
			const frames = applicationExceptionFrames(
				errorFields.stack,
				errorFields.name,
				errorFields.message,
			);
			window.snapshotActualWasmSql = {
				code: properties.lix_error_code,
				rustOrigin: properties.rust_origin,
				frameCandidates: frames.map(({ filename, lineno, colno }) => ({
					filename,
					lineno,
					colno,
				})),
			};
			posthog.captureException(
				error,
				exceptionTraceability({
					...properties,
					operation: "snapshot.fixture.actual_wasm_sql",
				}),
			);
		}
		if (!captured)
			throw new Error("The missing-table SQL query unexpectedly succeeded");
	} finally {
		await lix.close();
	}
	setTimeout(() => {
		const error = new Error("Controlled snapshot fixture uncaught failure");
		error.name = "SnapshotFixtureUncaughtError";
		throw error;
	}, 0);
	setTimeout(() => {
		void Promise.reject(
			Object.assign(
				new Error("Controlled snapshot fixture rejection failure"),
				{ name: "SnapshotFixtureRejectionError" },
			),
		);
	}, 25);
};

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
										document_content: "snapshot-fixture-private-response-body",
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
		[
			"unhandledRejection",
			"unhandledrejection",
			"Unhandled rejection fixture failure",
		],
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
							url.searchParams.set(
								"download_secret",
								"snapshot-fixture-query-secret",
							);
							return window.fetch(new Request(url, request));
						},
					}),
				REPOSITORY_ID,
				(error, properties) => {
					const traceable = exceptionTraceability(properties ?? {});
					posthog.captureException(error, traceable);
					window.snapshotPostHogCaptureExceptionCalls += 1;
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
