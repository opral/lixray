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
	CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

interface McpTelemetryIdentity {
	userId: string;
	clientId: string;
	isDemo?: boolean;
}

export interface McpTelemetrySession {
	onToolCall: McpToolCallObserver;
	completeRequest?: (observation: McpRequestObservation) => void;
	flush(): Promise<void>;
}

export interface McpRequestObservation {
	traceId: string;
	jsonRpcMethod: string;
	clientName?: string;
	clientVersion?: string;
	protocolVersion?: string;
	authenticationDurationMs: number;
	responseSerializationDurationMs: number;
	requestDurationMs: number;
	responseStatus: number;
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
	const toolCalls: Array<McpToolCallObservation> = [];
	const onToolCall = (observation: McpToolCallObservation): void => {
		toolCalls.push(observation);
	};
	const completeRequest = (request: McpRequestObservation): void => {
		const observations = toolCalls.length > 0 ? [...toolCalls] : [undefined];
		for (const observation of observations) {
			captureRequest(request, observation);
		}
	};
	const captureRequest = (
		request: McpRequestObservation,
		observation: McpToolCallObservation | undefined,
	): void => {
		const releaseId =
			env.LIXRAY_RELEASE_ID?.trim() ||
			env.CF_VERSION_METADATA?.id?.trim() ||
			env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
			"unknown";
		const outcome =
			observation?.outcome ??
			(request.responseStatus >= 400 ? "error" : "success");
		const properties: Record<string, unknown> = {
			$ai_trace_id: request.traceId,
			$ai_span_id: crypto.randomUUID(),
			$ai_span_name: observation
				? `mcp.${observation.toolName}`
				: `mcp.${request.jsonRpcMethod.replaceAll("/", ".")}`,
			$ai_latency: request.requestDurationMs / 1000,
			$ai_is_error: outcome === "error",
			mcp_server: "lixray",
			mcp_trace_id: request.traceId,
			jsonrpc_method: request.jsonRpcMethod,
			mcp_client_name: request.clientName ?? "unknown",
			mcp_client_version: request.clientVersion ?? "unknown",
			mcp_protocol_version: request.protocolVersion ?? "unknown",
			authentication_duration_ms: request.authenticationDurationMs,
			lix_resolution_duration_ms: observation?.lixResolutionDurationMs ?? 0,
			storage_execution_duration_ms:
				observation?.storageExecutionDurationMs ?? 0,
			response_serialization_duration_ms:
				request.responseSerializationDurationMs,
			request_duration_ms: request.requestDurationMs,
			response_status: request.responseStatus,
			outcome,
			duration_ms: observation?.durationMs ?? request.requestDurationMs,
			oauth_client_id: identity.clientId,
			environment: "production",
			release_id: releaseId,
		};
		if (observation) {
			properties.mcp_tool = observation.toolName;
			properties.tool_duration_ms = observation.durationMs;
			properties.mcp_surface_version = observation.surfaceVersion;
		}
		if (observation?.errorCode) {
			properties.error_code = observation.errorCode;
			properties.$ai_error = { code: observation.errorCode };
		}
		if (observation?.lixId) {
			properties.lix_id = observation.lixId;
		}
		if (observation?.executeInput) {
			properties.$ai_input_state = observation.executeInput;
			properties.statement_count = observation.executeInput.statementCount;
			properties.sql_operations = observation.executeInput.statements.map(
				(statement) => statement.operation,
			);
			properties.sql_shape_ids = observation.executeInput.statements.map(
				(statement) => statement.shapeId,
			);
		}
		if (observation?.executeOutput) {
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
					...(observation?.lixId ? { groups: { lix: observation.lixId } } : {}),
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
		completeRequest,
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
