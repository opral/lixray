import { PostHog, type EventMessage } from "posthog-node";
import {
	repositoryOpenedFromBind,
	type LixOpenedBind,
	type RepositoryOpenedEvent,
} from "./lix-opened-telemetry.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export interface RepositoryOpenedSinkEnvironment {
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
}

export interface RepositoryOpenedSinkIdentity {
	userId: string;
	isDemo?: boolean;
}

interface PostHogCaptureClient {
	captureImmediate(event: EventMessage): Promise<void>;
	shutdown(): Promise<void>;
}

export interface RepositoryOpenedSink {
	bind(
		input: Omit<LixOpenedBind, "environment" | "accountId"> & {
			accountId?: string;
		},
	): void;
	flush(): Promise<void>;
}

interface RepositoryOpenedSinkDependencies {
	createClient?: (
		token: string,
		options: { host: string; flushAt: number; flushInterval: number },
	) => PostHogCaptureClient;
	warn?: (message: string, error: unknown) => void;
}

/**
 * Host writer for `repository_opened`. MCP signed-context binds call this
 * instead of capturing inside the MCP tool handler.
 */
export function createRepositoryOpenedSink(
	env: RepositoryOpenedSinkEnvironment,
	identity: RepositoryOpenedSinkIdentity,
	dependencies: RepositoryOpenedSinkDependencies = {},
): RepositoryOpenedSink | null {
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
		warn("Failed to initialize repository_opened host sink", caught);
		return null;
	}

	const pendingCaptures: Array<Promise<void>> = [];
	return {
		bind(input) {
			const event = repositoryOpenedFromBind({
				...input,
				accountId: input.accountId ?? identity.userId,
				environment: "production",
				source: input.source ?? "mcp",
			});
			if (!event) return;
			captureRepositoryOpened(client, event, warn, pendingCaptures);
		},
		async flush() {
			await Promise.all(pendingCaptures);
			try {
				await client.shutdown();
			} catch (caught) {
				warn("Failed to shut down repository_opened host sink", caught);
			}
		},
	};
}

export function captureRepositoryOpened(
	client: PostHogCaptureClient,
	event: RepositoryOpenedEvent,
	warn: (message: string, error: unknown) => void,
	pendingCaptures: Array<Promise<void>>,
): void {
	try {
		const capture = client
			.captureImmediate({
				distinctId: event.distinctId,
				event: event.event,
				properties: event.properties,
				groups: { lix: event.properties.lix_id },
			})
			.catch((caught: unknown) => {
				warn("Failed to capture repository_opened", caught);
			});
		pendingCaptures.push(capture);
	} catch (caught) {
		warn("Failed to capture repository_opened", caught);
	}
}

function createPostHogClient(
	token: string,
	options: { host: string; flushAt: number; flushInterval: number },
): PostHogCaptureClient {
	return new PostHog(token, options);
}
