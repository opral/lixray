import { PostHog, type EventMessage } from "posthog-node";
import {
	USER_SIGNED_UP_EVENT,
	USER_SIGNED_UP_PATH,
} from "../lib/user-signed-up.ts";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

export { USER_SIGNED_UP_EVENT, USER_SIGNED_UP_PATH };

export interface UserSignupEnv {
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

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const claimedUserIds = new Set<string>();

export type SignupSource = "web" | "mcp";

export interface SignupIdentity {
	userId: string;
	token: string;
	isDemo?: boolean;
}

export interface SignupClaim {
	claimed: boolean;
	email: string | null;
	name: string | null;
}

export interface UserSignedUpProperties {
	email: string;
	name: string;
	signup_source?: SignupSource;
	auth_provider?: string;
}

interface PostHogCaptureClient {
	captureImmediate(event: EventMessage): Promise<void>;
	shutdown(): Promise<void>;
}

export interface UserSignupTelemetryDependencies {
	claim?: (
		env: UserSignupEnv,
		auth: SignupIdentity,
	) => Promise<SignupClaim | null>;
	createClient?: (
		token: string,
		options: { host: string; flushAt: number; flushInterval: number },
	) => PostHogCaptureClient;
	warn?: (message: string, error: unknown) => void;
}

export function resetUserSignupClaimCacheForTests(): void {
	claimedUserIds.clear();
}

export function userSignedUpProperties(identity: {
	email: string;
	name: string;
	signupSource?: SignupSource;
	authProvider?: string;
}): UserSignedUpProperties {
	const properties: UserSignedUpProperties = {
		email: identity.email.trim(),
		name: identity.name.trim(),
	};
	if (identity.signupSource) properties.signup_source = identity.signupSource;
	if (identity.authProvider) properties.auth_provider = identity.authProvider;
	return properties;
}

export function shouldCaptureUserSignedUp(
	env: UserSignupEnv,
	auth: Pick<SignupIdentity, "isDemo">,
): boolean {
	return (
		!auth.isDemo &&
		!isDemoEnvironment(env) &&
		isProductionTelemetryEnvironment(env) &&
		Boolean(resolvePosthogProjectToken(env))
	);
}

export async function claimLixrayUserSignup(
	env: Pick<UserSignupEnv, "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY">,
	auth: Pick<SignupIdentity, "token">,
): Promise<SignupClaim | null> {
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return null;
	}

	const claimUrl = new URL(
		"/rest/v1/rpc/claim_lixray_user_signup",
		env.SUPABASE_URL,
	);
	const response = await fetch(claimUrl, {
		method: "POST",
		headers: {
			apikey: env.SUPABASE_PUBLISHABLE_KEY,
			Authorization: `Bearer ${auth.token}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});
	if (!response.ok) {
		throw new Error(`Supabase rejected the signup claim (${response.status})`);
	}

	const rows: unknown = await response.json();
	const row = Array.isArray(rows) ? rows[0] : rows;
	if (!isSignupClaim(row)) return null;
	return row;
}

export async function maybeCaptureUserSignedUp(
	env: UserSignupEnv,
	auth: SignupIdentity,
	signupSource: SignupSource,
	dependencies: UserSignupTelemetryDependencies = {},
): Promise<"captured" | "already_captured" | "skipped"> {
	if (!shouldCaptureUserSignedUp(env, auth)) return "skipped";
	if (claimedUserIds.has(auth.userId)) return "already_captured";

	const warn =
		dependencies.warn ??
		((message: string, error: unknown) => console.warn(message, error));

	let claim: SignupClaim | null;
	try {
		claim = await (dependencies.claim ?? claimLixrayUserSignup)(env, auth);
	} catch (caught) {
		warn("Failed to claim LixRay signup", caught);
		return "skipped";
	}
	if (!claim) return "skipped";
	claimedUserIds.add(auth.userId);
	if (!claim.claimed) return "already_captured";

	const token = resolvePosthogProjectToken(env);
	if (!token) return "skipped";

	const properties = userSignedUpProperties({
		email: claim.email ?? "",
		name: claim.name ?? "",
		signupSource,
	});

	let client: PostHogCaptureClient;
	try {
		client = (dependencies.createClient ?? createPostHogClient)(token, {
			host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0,
		});
	} catch (caught) {
		warn("Failed to initialize signup telemetry", caught);
		return "skipped";
	}

	try {
		await client.captureImmediate({
			distinctId: auth.userId,
			event: USER_SIGNED_UP_EVENT,
			properties,
		});
	} catch (caught) {
		warn("Failed to capture LixRay signup", caught);
		return "skipped";
	} finally {
		try {
			await client.shutdown();
		} catch (caught) {
			warn("Failed to shut down signup telemetry", caught);
		}
	}

	return "captured";
}

function isSignupClaim(value: unknown): value is SignupClaim {
	if (!value || typeof value !== "object") return false;
	const claim = value as Record<string, unknown>;
	return (
		typeof claim.claimed === "boolean" &&
		(typeof claim.email === "string" || claim.email === null) &&
		(typeof claim.name === "string" || claim.name === null)
	);
}

function createPostHogClient(
	token: string,
	options: { host: string; flushAt: number; flushInterval: number },
): PostHogCaptureClient {
	return new PostHog(token, options);
}
