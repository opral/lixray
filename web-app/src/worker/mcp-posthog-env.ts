/**
 * Server-side PostHog environment for official MCP and product analytics.
 * Keep Railway PR naming in sync with Dockerfile and assert-railway-env.mjs.
 */
const RAILWAY_PR_ENVIRONMENT = /^(lixray-pr-\d+|pr-[a-z0-9]+-\d+)$/;

export interface PosthogProjectTokenEnv {
	POSTHOG_PROJECT_TOKEN?: string;
	VITE_PUBLIC_POSTHOG_TOKEN?: string;
	/** Personal API key (`phx_`). Never used as a capture token. */
	POSTHOG_API_KEY?: string;
}

export interface ProductionTelemetryEnv {
	POSTHOG_ENVIRONMENT?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
	VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
}

export interface DemoTelemetryEnv {
	LIXRAY_DEMO?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
}

export function isRailwayPullRequestEnvironment(
	name: string | undefined,
): boolean {
	return RAILWAY_PR_ENVIRONMENT.test(name ?? "");
}

export function isDemoEnvironment(env: DemoTelemetryEnv): boolean {
	return (
		env.LIXRAY_DEMO === "1" ||
		isRailwayPullRequestEnvironment(env.RAILWAY_ENVIRONMENT_NAME)
	);
}

export function isProductionTelemetryEnvironment(
	env: ProductionTelemetryEnv,
): boolean {
	return (
		env.POSTHOG_ENVIRONMENT === "production" ||
		env.RAILWAY_ENVIRONMENT_NAME === "production" ||
		env.VITE_PUBLIC_TELEMETRY_ENVIRONMENT === "production"
	);
}

/**
 * Project token for posthog-node / `@posthog/mcp` capture.
 * Prefer `POSTHOG_PROJECT_TOKEN`, then the public Vite project token.
 * Never read `POSTHOG_API_KEY` (`phx_` personal keys cannot capture).
 */
export function resolvePosthogProjectToken(
	env: PosthogProjectTokenEnv,
): string | undefined {
	const token =
		env.POSTHOG_PROJECT_TOKEN?.trim() ||
		env.VITE_PUBLIC_POSTHOG_TOKEN?.trim() ||
		"";
	return token || undefined;
}

/**
 * Official `@posthog/mcp` usage token, independent of native trace export.
 * Disabled in demo / Railway PR environments.
 */
export function resolveOfficialMcpPosthogToken(
	env: PosthogProjectTokenEnv & DemoTelemetryEnv,
	identity: { isDemo?: boolean } = {},
): string | undefined {
	if (identity.isDemo || isDemoEnvironment(env)) return undefined;
	return resolvePosthogProjectToken(env);
}
