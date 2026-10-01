import { isSpanContextValid } from "@opentelemetry/api";
import { tracer, failSpan } from "../telemetry.ts";
import { captureExceptionTelemetry, captureTelemetry } from "./telemetry.ts";
import { RepositoryRemoteSnapshotError } from "./repository-debug-remote.ts";

/** Capture the whole download, including response consumption, with replay context. */
export function downloadRepositorySnapshot(
	download: () => Promise<Blob>,
	repositoryId: string,
	capture: typeof captureExceptionTelemetry = captureExceptionTelemetry,
	captureEvent: typeof captureTelemetry = captureTelemetry,
): Promise<Blob> {
	return tracer.startActiveSpan(
		"repository.snapshot.download",
		{
			attributes: {
				"lix.id": repositoryId,
				"snapshot.action": "download_remote_snapshot",
			},
		},
		async (span) => {
			const started = Date.now();
			const attemptId = globalThis.crypto.randomUUID();
			span.setAttribute("snapshot.attempt_id", attemptId);
			span.setAttribute("http.route", "/lix/v1/{lix_id}/snapshot");
			span.setAttribute("http.request.method", "GET");
			const spanContext = span.spanContext();
			const correlation = isSpanContextValid(spanContext)
				? {
						$otel_trace_id: spanContext.traceId,
						$otel_span_id: spanContext.spanId,
					}
				: {};
			const reproduction = {
				action: "download_remote_snapshot",
				repository_id: repositoryId,
				method: "GET",
				endpoint: "/lix/v1/{lix_id}/snapshot",
			};
			const common = {
				operation: "repository_remote_snapshot_download",
				lix_id: repositoryId,
				snapshot_attempt_id: attemptId,
				lix_request_endpoint: "snapshot",
				lix_request_method: "GET",
				reproduction,
				...correlation,
			};
			captureEvent("repository_snapshot_download", {
				...common,
				outcome: "started",
			});
			try {
				const blob = await download();
				captureEvent("repository_snapshot_download", {
					...common,
					outcome: "succeeded",
					duration_ms: Date.now() - started,
					snapshot_bytes: blob.size,
				});
				return blob;
			} catch (error) {
				const aborted =
					(error instanceof Error && error.name === "AbortError") ||
					(error instanceof RepositoryRemoteSnapshotError &&
						error.cause instanceof Error &&
						error.cause.name === "AbortError");
				const stage =
					error instanceof RepositoryRemoteSnapshotError
						? error.failureStage
						: "download";
				const status =
					error instanceof RepositoryRemoteSnapshotError
						? error.status
						: undefined;
				const details = {
					...common,
					outcome: aborted ? "cancelled" : "failed",
					failure_stage: stage,
					...(typeof status === "number"
						? { lix_http_status: status, httpStatus: status }
						: {}),
					...(error instanceof RepositoryRemoteSnapshotError && error.requestId
						? { request_id: error.requestId }
						: {}),
					duration_ms: Date.now() - started,
				};
				span.setAttribute("snapshot.failure_stage", stage);
				if (error instanceof RepositoryRemoteSnapshotError && error.requestId)
					span.setAttribute("lix.request.id", error.requestId);
				if (status !== undefined)
					span.setAttribute("http.response.status_code", status);
				captureEvent("repository_snapshot_download", details);
				if (!aborted) {
					failSpan(span, "snapshot_download_failed");
					// Never forward a transport cause or response body into error tracking.
					const safeError = new Error(
						`Remote snapshot download failed (${stage}${status !== undefined ? `, HTTP ${status}` : ""})`,
					);
					safeError.name = "RepositorySnapshotDownloadError";
					capture(safeError, details);
				}
				throw error;
			} finally {
				span.end();
			}
		},
	);
}
