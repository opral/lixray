import { PostHog, type EventMessage } from "posthog-node";
import type {
	McpToolCallObservation,
	McpToolCallObserver,
} from "../mcp/server.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export interface McpTelemetryEnvironment {
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
}

export interface McpTelemetryIdentity {
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
		const properties: Record<string, string | number> = {
			tool_name: observation.toolName,
			outcome: observation.outcome,
			duration_ms: observation.durationMs,
			oauth_client_id: identity.clientId,
			environment: "production",
		};
		if (observation.errorCode) {
			properties.error_code = observation.errorCode;
		}
		if (observation.workspaceId) {
			properties.workspace_id = observation.workspaceId;
		}

		try {
			const capture = client
				.captureImmediate({
					distinctId: identity.userId,
					event: "mcp_tool_called",
					properties,
					...(observation.workspaceId
						? { groups: { workspace: observation.workspaceId } }
						: {}),
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
