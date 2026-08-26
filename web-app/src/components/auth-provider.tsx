import type { Session, User } from "@supabase/supabase-js";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { getBrowserSupabaseClient, localDevCredentials } from "~/lib/supabase";
import type { LixraySupabaseClient } from "~/lib/supabase";
import { DEMO_AUTH_TOKEN, DEMO_PROFILE_NAME } from "~/lib/demo-identity";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { normalizeAuthReturnTo } from "~/lib/auth-return-to";
import {
	authErrorTelemetryProperties,
	isOrphanedAuthError,
	loadValidatedInitialSession,
	orphanedSessionSignInUrl,
} from "~/lib/auth-session-validation";
import {
	captureErrorLogImmediately,
	captureExceptionTelemetry,
	captureTelemetryImmediately,
	resetTelemetry,
} from "~/lib/telemetry";

const RETURN_TO_KEY = "lixray.auth.return-to";

interface AuthContextValue {
	isLoaded: boolean;
	session: Session | null;
	user: User | null;
	client: LixraySupabaseClient | null;
	getAccessToken: () => Promise<string | null>;
	signInAsLocalDev: () => Promise<void>;
	signInAsProdDev: (password: string) => Promise<void>;
	signInWithGoogle: (returnTo?: string) => Promise<void>;
	signOut: () => Promise<void>;
	refreshSession: () => Promise<void>;
	validateSession: (
		operation: string,
	) => Promise<"valid" | "orphaned" | "unknown">;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const PREVIEW_DEMO_USER = {
	id: "00000000-0000-4000-8000-000000000005",
	aud: "authenticated",
	role: "authenticated",
	email: "preview-user@lixray.invalid",
	app_metadata: {},
	user_metadata: { full_name: DEMO_PROFILE_NAME },
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
} as User;

export function AuthProvider({ children }: { children: ReactNode }) {
	return isDemoModeEnabled ? (
		<DemoAuthProvider>{children}</DemoAuthProvider>
	) : (
		<SupabaseAuthProvider>{children}</SupabaseAuthProvider>
	);
}

function DemoAuthProvider({ children }: { children: ReactNode }) {
	const beginPreviewSignIn = useCallback((returnTo = "/open") => {
		const safeReturnTo = normalizeAuthReturnTo(returnTo);
		window.location.assign(
			`/sign-in?returnTo=${encodeURIComponent(safeReturnTo)}`,
		);
		return Promise.resolve();
	}, []);
	const signOut = useCallback(() => {
		resetTelemetry();
		return Promise.resolve();
	}, []);
	const value = useMemo<AuthContextValue>(
		() => ({
			isLoaded: true,
			session: null,
			user: PREVIEW_DEMO_USER,
			client: null,
			getAccessToken: () => Promise.resolve(DEMO_AUTH_TOKEN),
			signInAsLocalDev: () => Promise.resolve(),
			signInAsProdDev: () => Promise.resolve(),
			signInWithGoogle: beginPreviewSignIn,
			signOut,
			refreshSession: () => Promise.resolve(),
			validateSession: () => Promise.resolve("valid"),
		}),
		[beginPreviewSignIn, signOut],
	);
	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
	const [client, setClient] = useState<LixraySupabaseClient | null>(null);
	const [session, setSession] = useState<Session | null>(null);
	const [isLoaded, setIsLoaded] = useState(false);

	useEffect(() => {
		const supabase = getBrowserSupabaseClient();
		let disposed = false;
		let authStateChanged = false;
		setClient(supabase);

		const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
			if (event === "INITIAL_SESSION") return;
			authStateChanged = true;
			if (!disposed) {
				setSession(nextSession);
				setIsLoaded(true);
			}
		});

		void loadValidatedInitialSession(supabase.auth)
			.then(async (result) => {
				if (disposed || authStateChanged) return;
				if (result.kind === "orphaned") {
					await clearOrphanedSession(
						supabase,
						result.error,
						"initial_session_validation",
					);
					return;
				}
				if (result.kind === "validation_failed") {
					captureExceptionTelemetry(result.error, {
						operation: "auth_session_validation",
						auth_validation_operation: "initial_session_validation",
						...authErrorTelemetryProperties(result.error),
					});
				}
				setSession(
					result.kind === "authenticated"
						? result.session
						: result.kind === "validation_failed"
							? (result.session ?? null)
							: null,
				);
				setIsLoaded(true);
			})
			.catch((error: unknown) => {
				if (disposed || authStateChanged) return;
				captureExceptionTelemetry(error, {
					operation: "auth_session_validation",
					auth_validation_operation: "initial_session_validation",
					...authErrorTelemetryProperties(error),
				});
				setSession(null);
				setIsLoaded(true);
			});

		return () => {
			disposed = true;
			data.subscription.unsubscribe();
		};
	}, []);

	const getAccessToken = useCallback(async () => {
		if (!client) return null;
		const { data, error } = await client.auth.getSession();
		if (error) throw error;
		return data.session?.access_token ?? null;
	}, [client]);

	const signInWithGoogle = useCallback(
		async (returnTo = "/open") => {
			if (!client) throw new Error("Authentication is still loading");
			const safeReturnTo = normalizeAuthReturnTo(returnTo);
			window.sessionStorage.setItem(RETURN_TO_KEY, safeReturnTo);
			const { error } = await client.auth.signInWithOAuth({
				provider: "google",
				options: {
					redirectTo: `${window.location.origin}/auth/callback`,
				},
			});
			if (error) throw error;
		},
		[client],
	);
	const signInAsLocalDev = useCallback(async () => {
		if (!client) throw new Error("Authentication is still loading");
		if (!localDevCredentials) {
			throw new Error("Local development login is not enabled");
		}
		const { error } = await client.auth.signInWithPassword(localDevCredentials);
		if (error) throw error;
	}, [client]);
	const signInAsProdDev = useCallback(
		async (password: string) => {
			if (!client) throw new Error("Authentication is still loading");
			if (!password) {
				throw new Error("Production developer password is required");
			}
			const response = await fetch("/auth/email", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			let body: {
				access_token?: string;
				refresh_token?: string;
				msg?: string;
			};
			try {
				body = (await response.json()) as typeof body;
			} catch {
				throw new Error("Production developer sign-in failed");
			}
			if (!response.ok || !body.access_token || !body.refresh_token) {
				throw new Error(body.msg ?? "Production developer sign-in failed");
			}
			const { error } = await client.auth.setSession({
				access_token: body.access_token,
				refresh_token: body.refresh_token,
			});
			if (error) throw error;
		},
		[client],
	);
	const refreshSession = useCallback(async () => {
		if (!client) {
			setSession(null);
			return;
		}
		const { data, error } = await client.auth.refreshSession();
		if (error) {
			setSession(null);
			throw error;
		}
		setSession(data.session);
		setIsLoaded(true);
	}, [client]);
	const signOut = useCallback(async () => {
		if (!client) return;
		const { error } = await client.auth.signOut();
		if (error) throw error;
		resetTelemetry();
	}, [client]);
	const validateSession = useCallback(
		async (operation: string): Promise<"valid" | "orphaned" | "unknown"> => {
			if (!client) return "unknown";
			try {
				const { data, error } = await client.auth.getUser();
				if (!error && data.user) return "valid";
				if (!data.user && isOrphanedAuthError(error)) {
					setSession(null);
					setIsLoaded(true);
					await clearOrphanedSession(client, error, operation);
					return "orphaned";
				}
				captureExceptionTelemetry(error, {
					operation: "auth_session_validation",
					auth_validation_operation: operation,
					...authErrorTelemetryProperties(error),
				});
				return "unknown";
			} catch (error: unknown) {
				captureExceptionTelemetry(error, {
					operation: "auth_session_validation",
					auth_validation_operation: operation,
					...authErrorTelemetryProperties(error),
				});
				return "unknown";
			}
		},
		[client],
	);

	const value = useMemo<AuthContextValue>(
		() => ({
			isLoaded,
			session,
			user: session?.user ?? null,
			client,
			getAccessToken,
			signInAsLocalDev,
			signInAsProdDev,
			signInWithGoogle,
			signOut,
			refreshSession,
			validateSession,
		}),
		[
			client,
			getAccessToken,
			isLoaded,
			session,
			signInAsLocalDev,
			signInAsProdDev,
			signInWithGoogle,
			signOut,
			refreshSession,
			validateSession,
		],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

async function clearOrphanedSession(
	client: LixraySupabaseClient,
	error: unknown,
	operation: string,
): Promise<void> {
	const telemetryProperties = {
		auth_validation_operation: operation,
		...authErrorTelemetryProperties(error),
	};
	await Promise.all([
		captureTelemetryImmediately(
			"webapp_auth_session_orphaned",
			telemetryProperties,
		),
		captureErrorLogImmediately("Auth session orphaned", telemetryProperties),
	]);
	await client.auth.signOut({ scope: "local" });
	resetTelemetry();
	const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	const returnTo =
		window.location.pathname === "/sign-in"
			? "/home"
			: normalizeAuthReturnTo(currentPath);
	window.location.replace(orphanedSessionSignInUrl(returnTo));
}

export function useAuth() {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth must be used inside AuthProvider");
	return value;
}

export function takeAuthReturnTo(): string {
	const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/open";
	window.sessionStorage.removeItem(RETURN_TO_KEY);
	return normalizeAuthReturnTo(returnTo);
}

/**
 * The staged returnTo without consuming it — the callback error card uses it
 * so "Try again" restarts /sign-in with the original destination (1c).
 */
export function peekAuthReturnTo(): string {
	return normalizeAuthReturnTo(
		window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/open",
	);
}
