import { sanitizeRepositoryErrorFrames } from "../lib/repository-error-stack.ts";
import {
	repositoryOpenDiagnostics,
	repositoryOpenFailureMessage,
} from "../lib/repository-open-telemetry.ts";
import {
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";
import type { WorkerEnv } from "./handler.ts";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_QUALITIES = [
	"active_trace",
	"standalone_trace",
	"provided_trace",
	"no_trace_provider",
	"diagnostic_only",
] as const;

interface RepositoryOpenCorrelation {
	error_id: string;
	error_correlation: (typeof CORRELATION_QUALITIES)[number];
	$otel_trace_id?: string;
	$otel_span_id?: string;
}

function reportCorrelation(value: unknown): RepositoryOpenCorrelation {
	const input =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const errorId =
		typeof input.error_id === "string" && UUID.test(input.error_id)
			? input.error_id.toLowerCase()
			: crypto.randomUUID();
	const quality =
		typeof input.error_correlation === "string" &&
		CORRELATION_QUALITIES.includes(
			input.error_correlation as (typeof CORRELATION_QUALITIES)[number],
		)
			? (input.error_correlation as RepositoryOpenCorrelation["error_correlation"])
			: undefined;
	const traceId = input.$otel_trace_id;
	const spanId = input.$otel_span_id;
	const validTraceId =
		typeof traceId === "string" &&
		/^[a-f0-9]{32}$/i.test(traceId) &&
		!/^0+$/i.test(traceId);
	const validSpanId =
		typeof spanId === "string" &&
		/^[a-f0-9]{16}$/i.test(spanId) &&
		!/^0+$/i.test(spanId);
	if (
		validTraceId &&
		validSpanId &&
		quality &&
		quality !== "no_trace_provider" &&
		quality !== "diagnostic_only"
	) {
		return {
			error_id: errorId,
			error_correlation: quality,
			$otel_trace_id: (traceId as string).toLowerCase(),
			$otel_span_id: (spanId as string).toLowerCase(),
		};
	}
	if (
		!validTraceId &&
		!validSpanId &&
		(quality === "no_trace_provider" || quality === "diagnostic_only")
	)
		return { error_id: errorId, error_correlation: quality };
	return { error_id: errorId, error_correlation: "diagnostic_only" };
}

export function parseRepositoryOpenReport(body: unknown) {
	if (!body || typeof body !== "object") return null;
	const input = body as Record<string, unknown>;
	if (
		typeof input.repositoryId !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
			input.repositoryId,
		)
	)
		return null;
	if (!input.diagnostic || typeof input.diagnostic !== "object") return null;
	const diagnostic = input.diagnostic as Record<string, unknown>;
	const fields = repositoryOpenDiagnostics({
		code: diagnostic.lix_error_code,
		name: diagnostic.error_kind,
		details: diagnostic,
	});
	const release =
		typeof input.release === "string" && /^[a-f0-9]{40}$/.test(input.release)
			? input.release
			: "unknown";
	const correlation = reportCorrelation(input.correlation);
	return {
		repositoryId: input.repositoryId,
		release,
		correlation,
		fields,
		frames: sanitizeRepositoryErrorFrames(input.frames),
	};
}

export async function captureRepositoryOpenReport(
	report: NonNullable<ReturnType<typeof parseRepositoryOpenReport>>,
	userId: string,
	env: WorkerEnv,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	const properties = {
		...report.fields,
		operation: "repository_open",
		service_name: "lixray-web",
		surface: "web",
		delivery: "first_party",
		lix_id: report.repositoryId,
		client_release: report.release,
		server_release: env.LIXRAY_RELEASE_ID ?? "unknown",
		environment: "production",
		...report.correlation,
	};
	// This bounded structural record survives a downstream ingestion failure.
	console.error("Repository open failed", properties);
	const token = resolvePosthogProjectToken(env);
	if (!token || !isProductionTelemetryEnvironment(env)) return false;
	try {
		const response = await fetcher(
			new URL("/capture/", env.POSTHOG_HOST || "https://us.i.posthog.com"),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					api_key: token,
					event: "$exception",
					properties: {
						...properties,
						distinct_id: userId,
						$exception_list: [
							{
								type:
									report.fields.lix_error_code ??
									report.fields.error_kind ??
									"RepositoryOpenError",
								value: repositoryOpenFailureMessage(
									{ details: report.fields },
									"Repository opening failed",
								),
								mechanism: { handled: true, type: "generic" },
								...(report.frames.length
									? { stacktrace: { type: "raw", frames: report.frames } }
									: {}),
							},
						],
					},
				}),
				signal: AbortSignal.timeout(4_000),
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}
