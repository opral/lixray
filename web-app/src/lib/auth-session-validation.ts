import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { Properties } from "posthog-js";

const MAX_AUTH_ERROR_CODE_LENGTH = 200;

// Auth state subscriptions own session updates: refresh failures can return a
// null session while the SDK deliberately retains a recoverable stored session.
// Successful refresh and terminal session removal emit their own auth events.
export async function refreshBrowserSession(
	auth: Pick<SupabaseClient["auth"], "refreshSession">,
): Promise<void> {
	const { error } = await auth.refreshSession();
	if (error) throw error;
}

export async function signOutBrowserSession(
	auth: Pick<SupabaseClient["auth"], "signOut">,
): Promise<void> {
	// Signing out of this browser must preserve independent MCP connections.
	const { error } = await auth.signOut({ scope: "local" });
	if (error) throw error;
}

interface AuthErrorShape {
	code?: unknown;
	status?: unknown;
}

interface PersistedSessionAuth {
	getSession: () => Promise<{
		data: { session: Session | null };
		error: unknown;
	}>;
	getUser: () => Promise<{
		data: { user: User | null };
		error: unknown;
	}>;
}

export type ValidatedInitialSession =
	| { kind: "authenticated"; session: Session }
	| { kind: "signed_out" }
	| { kind: "orphaned"; error: unknown }
	| { kind: "validation_failed"; error: unknown; session?: Session };

/** Retry an indeterminate cold start without treating it as a signed-out login. */
export function observeInitialSession(
	auth: PersistedSessionAuth,
	onResult: (result: ValidatedInitialSession) => void,
): () => void {
	let cancelled = false;
	let retryDelay = 1_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const attempt = async () => {
		let result: ValidatedInitialSession;
		try {
			result = await loadValidatedInitialSession(auth);
		} catch (error) {
			result = { kind: "validation_failed", error };
		}
		if (cancelled) return;
		onResult(result);
		if (!cancelled && result.kind === "validation_failed" && !result.session) {
			timer = setTimeout(() => {
				void attempt();
			}, retryDelay);
			retryDelay = Math.min(retryDelay * 2, 30_000);
		}
	};
	void attempt();
	return () => {
		cancelled = true;
		clearTimeout(timer);
	};
}

export async function loadValidatedInitialSession(
	auth: PersistedSessionAuth,
): Promise<ValidatedInitialSession> {
	const sessionResponse = await auth.getSession();
	if (sessionResponse.error) {
		return {
			kind: "validation_failed",
			error: sessionResponse.error,
			session: sessionResponse.data.session ?? undefined,
		};
	}
	if (!sessionResponse.data.session) return { kind: "signed_out" };

	const userResponse = await auth.getUser();
	if (!userResponse.error && userResponse.data.user) {
		return {
			kind: "authenticated",
			session: {
				...sessionResponse.data.session,
				user: userResponse.data.user,
			},
		};
	}
	if (!userResponse.data.user && isOrphanedAuthError(userResponse.error)) {
		return { kind: "orphaned", error: userResponse.error };
	}
	return {
		kind: "validation_failed",
		error: userResponse.error,
		session: sessionResponse.data.session,
	};
}

export function isOrphanedAuthError(error: unknown): boolean {
	if (error === null || error === undefined) return true;
	if (typeof error !== "object") return false;
	const candidate = error as AuthErrorShape;
	if (
		typeof candidate.status === "number" &&
		[401, 403, 404].includes(candidate.status)
	) {
		return true;
	}
	return (
		typeof candidate.code === "string" &&
		[
			"bad_jwt",
			"refresh_token_not_found",
			"session_not_found",
			"user_not_found",
		].includes(candidate.code)
	);
}

export function authErrorTelemetryProperties(error: unknown): Properties {
	if (!error || typeof error !== "object") return {};
	const candidate = error as AuthErrorShape;
	return {
		...(typeof candidate.code === "string"
			? {
					auth_error_code: candidate.code.slice(0, MAX_AUTH_ERROR_CODE_LENGTH),
				}
			: {}),
		...(typeof candidate.status === "number"
			? { auth_error_status: candidate.status }
			: {}),
	};
}

export function orphanedSessionSignInUrl(path: string): string {
	return `/sign-in?returnTo=${encodeURIComponent(path || "/home")}`;
}
