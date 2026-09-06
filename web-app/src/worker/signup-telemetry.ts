import { PostHog, type EventMessage, type IdentifyMessage } from "posthog-node";
import type { SignupTelemetryContext } from "../lib/signup-telemetry.ts";
import { PRODUCT_EVENTS } from "../lib/telemetry-events.ts";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

export const USER_SIGNED_UP_EVENT = PRODUCT_EVENTS.userSignedUp;

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const SIGNUP_TELEMETRY_EPOCH_MS = Date.parse("2026-08-26T00:00:00.000Z");

interface SignupTelemetryEnvironment {
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	VITE_PUBLIC_POSTHOG_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
	LIXRAY_DEMO?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
}

interface SignupTelemetryIdentity {
	/** Stable LixRay actor used for product analytics attribution. */
	userId: string;
	/** Credential subject used only to verify the Supabase Auth response. */
	authUserId?: string;
	token: string;
	isDemo?: boolean;
}

interface SupabaseAuthUser {
	id: string;
	email?: string;
	created_at: string;
	app_metadata?: Record<string, unknown>;
	user_metadata?: Record<string, unknown>;
}

interface SignupPostHogClient {
	identify(message: IdentifyMessage): void;
	flush(): Promise<void>;
	captureImmediate(event: EventMessage): Promise<void>;
	shutdown(): Promise<void>;
}

interface SignupTelemetryDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	createClient?: (
		token: string,
		options: { host: string; flushAt: number; flushInterval: number },
	) => SignupPostHogClient;
	warn?: (message: string, error: unknown) => void;
}

export type SignupTelemetryResult =
	| "captured"
	| "not_new"
	| "disabled"
	| "failed";

/**
 * Captures the one cross-surface signup event from authenticated server state.
 * The auth user ID is also the deterministic PostHog event UUID, making retries
 * from the web callback idempotent.
 */
export async function captureUserSignedUp(
	env: SignupTelemetryEnvironment,
	identity: SignupTelemetryIdentity,
	context: SignupTelemetryContext,
	dependencies: SignupTelemetryDependencies = {},
): Promise<SignupTelemetryResult> {
	const token = resolvePosthogProjectToken(env);
	if (
		!token ||
		!isProductionTelemetryEnvironment(env) ||
		identity.isDemo ||
		isDemoEnvironment(env)
	) {
		return "disabled";
	}
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return "failed";

	const warn =
		dependencies.warn ??
		((message: string, error: unknown) => console.warn(message, error));
	try {
		const user = await fetchAuthenticatedUser(
			env.SUPABASE_URL,
			env.SUPABASE_PUBLISHABLE_KEY,
			identity,
			dependencies.fetch ?? fetch,
		);
		if (!isSignupTelemetryEligible(user, dependencies.now?.() ?? Date.now())) {
			return "not_new";
		}

		const personProperties = authUserPersonProperties(user);
		const client = (dependencies.createClient ?? createPostHogClient)(token, {
			host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0,
		});
		try {
			client.identify({
				distinctId: identity.userId,
				properties: personProperties,
			});
			await client.flush();
			await client.captureImmediate({
				distinctId: identity.userId,
				event: USER_SIGNED_UP_EVENT,
				uuid: identity.userId,
				timestamp: new Date(user.created_at),
				properties: {
					...personProperties,
					auth_provider: authProvider(user),
					surface: context.surface,
					signup_source: context.source,
					environment: "production",
				},
			});
		} finally {
			await client.shutdown();
		}
		return "captured";
	} catch (error: unknown) {
		warn("Failed to capture signup telemetry", error);
		return "failed";
	}
}

export function isSignupTelemetryEligible(
	user: Pick<SupabaseAuthUser, "created_at">,
	now: number,
): boolean {
	const createdAt = Date.parse(user.created_at);
	if (!Number.isFinite(createdAt)) return false;
	return createdAt >= SIGNUP_TELEMETRY_EPOCH_MS && createdAt <= now + 60_000;
}

async function fetchAuthenticatedUser(
	supabaseUrl: string,
	publishableKey: string,
	identity: SignupTelemetryIdentity,
	fetchImpl: typeof fetch,
): Promise<SupabaseAuthUser> {
	const userUrl = new URL("/auth/v1/user", supabaseUrl);
	const response = await fetchImpl(userUrl, {
		headers: {
			apikey: publishableKey,
			Authorization: `Bearer ${identity.token}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(`Supabase user lookup failed (${response.status})`);
	}
	const candidate: unknown = await response.json();
	if (!candidate || typeof candidate !== "object") {
		throw new Error("Supabase user lookup returned an invalid payload");
	}
	const user = candidate as Partial<SupabaseAuthUser>;
	if (
		user.id !== (identity.authUserId ?? identity.userId) ||
		typeof user.created_at !== "string" ||
		!user.created_at
	) {
		throw new Error(
			"Supabase user lookup did not match the authenticated user",
		);
	}
	return user as SupabaseAuthUser;
}

function authUserPersonProperties(
	user: SupabaseAuthUser,
): Record<string, string> {
	const properties: Record<string, string> = {};
	if (typeof user.email === "string" && user.email.trim()) {
		properties.email = user.email.trim();
	}
	const name = userName(user);
	if (name) properties.name = name;
	return properties;
}

function userName(user: SupabaseAuthUser): string | undefined {
	for (const key of ["full_name", "name"] as const) {
		const value = user.user_metadata?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function authProvider(user: SupabaseAuthUser): string {
	const provider = user.app_metadata?.provider;
	return typeof provider === "string" && provider.trim()
		? provider.trim()
		: "unknown";
}

function createPostHogClient(
	token: string,
	options: { host: string; flushAt: number; flushInterval: number },
): SignupPostHogClient {
	return new PostHog(token, options);
}
