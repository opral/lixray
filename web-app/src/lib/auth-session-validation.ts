import type { Session, User } from "@supabase/supabase-js";
import type { Properties } from "posthog-js";

const MAX_AUTH_ERROR_CODE_LENGTH = 200;

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
