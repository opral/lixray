import { PostHog, type EventMessage } from "posthog-node";
import {
	lixEngineAiSpan,
	type LixEngineSpanLike,
} from "../lib/lix-engine-telemetry.ts";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

interface LixEngineTelemetryEnvironment {
	POSTHOG_PROJECT_TOKEN?: string;
	VITE_PUBLIC_POSTHOG_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
	LIXRAY_DEMO?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
	RAILWAY_GIT_COMMIT_SHA?: string;
}

interface LixEngineTelemetryIdentity {
	userId: string;
	isDemo?: boolean;
}

export interface LixEngineTelemetrySession {
	onSpan(span: LixEngineSpanLike): void;
	flush(): Promise<void>;
}

interface PostHogCaptureClient {
	captureImmediate(event: EventMessage): Promise<void>;
	shutdown(): Promise<void>;
}

interface LixEngineTelemetryDependencies {
	createClient?: (
		token: string,
		options: { host: string; flushAt: number; flushInterval: number },
	) => PostHogCaptureClient;
	warn?: (message: string, error: unknown) => void;
}

/**
 * Worker sink for Lix `onSpan` records. MCP tool wall clock stays on official
 * `$mcp_tool_call` (`$mcp_duration_ms`). This path never names `mcp.*`.
 */
export function createLixEngineTelemetrySession(
	env: LixEngineTelemetryEnvironment,
	identity: LixEngineTelemetryIdentity,
	dependencies: LixEngineTelemetryDependencies = {},
): LixEngineTelemetrySession | null {
	const token = resolvePosthogProjectToken(env);
	if (
		!token ||
		!isProductionTelemetryEnvironment(env) ||
		identity.isDemo ||
		isDemoEnvironment(env)
	) {
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
		warn("Failed to initialize Lix engine telemetry", caught);
		return null;
	}

	const pendingCaptures: Array<Promise<void>> = [];
	const releaseId =
		env.LIXRAY_RELEASE_ID?.trim() ||
		env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
		"unknown";
	const onSpan = (span: LixEngineSpanLike): void => {
		const mapped = lixEngineAiSpan(span);
		if (!mapped) return;
		const properties: Record<string, unknown> = {
			...mapped.properties,
			environment: "production",
			release_id: releaseId,
		};
		try {
			const capture = client
				.captureImmediate({
					distinctId: identity.userId,
					event: mapped.event,
					properties,
					...(mapped.lixId ? { groups: { lix: mapped.lixId } } : {}),
				})
				.catch((caught: unknown) => {
					warn("Failed to capture Lix engine telemetry", caught);
				});
			pendingCaptures.push(capture);
		} catch (caught) {
			warn("Failed to capture Lix engine telemetry", caught);
		}
	};

	return {
		onSpan,
		async flush(): Promise<void> {
			await Promise.all(pendingCaptures);
			try {
				await client.shutdown();
			} catch (caught) {
				warn("Failed to shut down Lix engine telemetry", caught);
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
