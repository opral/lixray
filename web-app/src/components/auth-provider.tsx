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
import { DEMO_AUTH_TOKEN } from "~/lib/demo-identity";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { normalizeAuthReturnTo } from "~/lib/auth-return-to";
import { resetTelemetry } from "~/lib/telemetry";

const RETURN_TO_KEY = "lixray.auth.return-to";

interface AuthContextValue {
	isLoaded: boolean;
	session: Session | null;
	user: User | null;
	client: LixraySupabaseClient | null;
	getAccessToken: () => Promise<string | null>;
	signInAsLocalDev: () => Promise<void>;
	signInWithGoogle: (returnTo?: string) => Promise<void>;
	signOut: () => Promise<void>;
	refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const PREVIEW_DEMO_USER = {
	id: "00000000-0000-4000-8000-000000000005",
	aud: "authenticated",
	role: "authenticated",
	email: "preview-user@lixray.invalid",
	app_metadata: {},
	user_metadata: { full_name: "Preview user" },
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
	const beginPreviewSignIn = useCallback((returnTo = "/home") => {
		const safeReturnTo = normalizeAuthReturnTo(returnTo);
		window.location.assign(
			`/sign-in?returnTo=${encodeURIComponent(safeReturnTo)}`,
		);
		return Promise.resolve();
	}, []);
	const signOut = useCallback(async () => {
		resetTelemetry();
	}, []);
	const value = useMemo<AuthContextValue>(
		() => ({
			isLoaded: true,
			session: null,
			user: PREVIEW_DEMO_USER,
			client: null,
			getAccessToken: () => Promise.resolve(DEMO_AUTH_TOKEN),
			signInAsLocalDev: () => Promise.resolve(),
			signInWithGoogle: beginPreviewSignIn,
			signOut,
			refreshSession: () => Promise.resolve(),
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
		setClient(supabase);

		const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
			if (!disposed) {
				setSession(nextSession);
				setIsLoaded(true);
			}
		});

		void supabase.auth.getSession().then(({ data: initialData }) => {
			if (!disposed) {
				setSession(initialData.session);
				setIsLoaded(true);
			}
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
		async (returnTo = "/home") => {
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
	const refreshSession = useCallback(async () => {
		if (!client) {
			setSession(null);
			return;
		}
		const { data, error } = await client.auth.getSession();
		if (error) throw error;
		setSession(data.session);
		setIsLoaded(true);
	}, [client]);
	const signOut = useCallback(async () => {
		if (!client) return;
		const { error } = await client.auth.signOut();
		if (error) throw error;
		resetTelemetry();
	}, [client]);

	const value = useMemo<AuthContextValue>(
		() => ({
			isLoaded,
			session,
			user: session?.user ?? null,
			client,
			getAccessToken,
			signInAsLocalDev,
			signInWithGoogle,
			signOut,
			refreshSession,
		}),
		[
			client,
			getAccessToken,
			isLoaded,
			session,
			signInAsLocalDev,
			signInWithGoogle,
			signOut,
			refreshSession,
		],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth must be used inside AuthProvider");
	return value;
}

export function takeAuthReturnTo(): string {
	const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/home";
	window.sessionStorage.removeItem(RETURN_TO_KEY);
	return normalizeAuthReturnTo(returnTo);
}
