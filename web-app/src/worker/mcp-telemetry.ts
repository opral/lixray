import { PostHog, type EventMessage } from "posthog-node";
import type {
	McpToolCallObservation,
	McpToolCallObserver,
} from "../mcp/server.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

interface McpTelemetryEnvironment {
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_GIT_COMMIT_SHA?: string;
}

interface McpTelemetryIdentity {
	userId: string;
	clientId: string;
	isDemo?: boolean;
}

export interface McpTelemetrySession {
	onToolCall: McpToolCallObserver;
	flush(): Promise<void>;
}

interface PostHogCaptureClient {
	captureImmediate(event: EventMessage): Promise<void>;
	shutdown(): Promise<void>;
}

interface McpTelemetryDependencies {
	createClient?: (
		token: string,
		options: { host: string; flushAt: number; flushInterval: number },
	) => PostHogCaptureClient;
	warn?: (message: string, error: unknown) => void;
}

export function createMcpTelemetrySession(
	env: McpTelemetryEnvironment,
	identity: McpTelemetryIdentity,
	dependencies: McpTelemetryDependencies = {},
): McpTelemetrySession | null {
	const token = env.POSTHOG_PROJECT_TOKEN?.trim();
	if (!token || env.POSTHOG_ENVIRONMENT !== "production" || identity.isDemo) {
		return null;
	}

	const warn =
		dependencies.warn ??
		((message: string, error: unknown) => console.warn(message, error));
	let client: PostHogCaptureClient;
	try {
		client = (dependencies.createClient ?? createPostHogClient)(token, {
			host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0,
		});
	} catch (caught) {
		warn("Failed to initialize MCP telemetry", caught);
		return null;
	}

	const pendingCaptures: Array<Promise<void>> = [];
	const onToolCall = (observation: McpToolCallObservation): void => {
		const traceId = crypto.randomUUID();
		const spanId = crypto.randomUUID();
		const releaseId =
			env.LIXRAY_RELEASE_ID?.trim() ||
			env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
			"unknown";
		const properties: Record<string, unknown> = {
			$ai_trace_id: traceId,
			$ai_span_id: spanId,
			$ai_span_name: `mcp.${observation.toolName}`,
			$ai_latency: observation.durationMs / 1000,
			$ai_is_error: observation.outcome === "error",
			mcp_server: "lixray",
			mcp_tool: observation.toolName,
			request_id: observation.requestId,
			outcome: observation.outcome,
			duration_ms: observation.durationMs,
			oauth_client_id: identity.clientId,
			environment: "production",
			release_id: releaseId,
			mcp_surface_version: observation.surfaceVersion,
		};
		if (observation.errorCode) {
			properties.error_code = observation.errorCode;
			properties.$ai_error = { code: observation.errorCode };
		}
		if (observation.lixId) {
			properties.lix_id = observation.lixId;
		}
		if (observation.executeInput) {
			properties.$ai_input_state = observation.executeInput;
			properties.statement_count = observation.executeInput.statementCount;
			properties.sql_operations = observation.executeInput.statements.map(
				(statement) => statement.operation,
			);
			properties.sql_shape_ids = observation.executeInput.statements.map(
				(statement) => statement.shapeId,
			);
		}
		if (observation.executeOutput) {
			properties.$ai_output_state = observation.executeOutput;
			properties.result_count = observation.executeOutput.resultCount;
			properties.row_count = observation.executeOutput.rowCount;
			properties.rows_affected = observation.executeOutput.rowsAffected;
			properties.notice_codes = observation.executeOutput.noticeCodes;
			properties.notice_count = observation.executeOutput.results.reduce(
				(sum, result) => sum + result.noticeCodes.length,
				0,
			);
		}

		try {
			const capture = client
				.captureImmediate({
					distinctId: identity.userId,
					event: "$ai_span",
					properties,
					...(observation.lixId ? { groups: { lix: observation.lixId } } : {}),
				})
				.catch((caught: unknown) => {
					warn("Failed to capture MCP telemetry", caught);
				});
			pendingCaptures.push(capture);
		} catch (caught) {
			warn("Failed to capture MCP telemetry", caught);
		}
	};

	return {
		onToolCall,
		async flush(): Promise<void> {
			await Promise.all(pendingCaptures);
			try {
				await client.shutdown();
			} catch (caught) {
				warn("Failed to shut down MCP telemetry", caught);
			}
		},
	};
}

function createPostHogClient(
	token: string,
	options: { host: string; flushAt: number; flushInterval: number },
): PostHogCaptureClient {
	return new PostHog(token, options);
}
