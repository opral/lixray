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
import { isPreviewMode } from "~/lib/e2e-client";
import { getBrowserSupabaseClient, localDevCredentials } from "~/lib/supabase";
import type { LixraySupabaseClient } from "~/lib/supabase";

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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	if (isPreviewMode) {
		return <PreviewAuthProvider>{children}</PreviewAuthProvider>;
	}
	return <SupabaseAuthProvider>{children}</SupabaseAuthProvider>;
}

function PreviewAuthProvider({ children }: { children: ReactNode }) {
	const unavailable = () =>
		Promise.reject(
			new Error("Authentication is unavailable in frontend PR previews"),
		);
	const value: AuthContextValue = {
		isLoaded: true,
		session: null,
		user: null,
		client: null,
		getAccessToken: () => Promise.resolve(null),
		signInAsLocalDev: unavailable,
		signInWithGoogle: unavailable,
		signOut: () => Promise.resolve(),
	};
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
		async (returnTo = "/") => {
			if (!client) throw new Error("Authentication is still loading");
			const safeReturnTo = normalizeReturnTo(returnTo);
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

	const signOut = useCallback(async () => {
		if (!client) return;
		const { error } = await client.auth.signOut();
		if (error) throw error;
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
		}),
		[
			client,
			getAccessToken,
			isLoaded,
			session,
			signInAsLocalDev,
			signInWithGoogle,
			signOut,
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
	const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/";
	window.sessionStorage.removeItem(RETURN_TO_KEY);
	return normalizeReturnTo(returnTo);
}

function normalizeReturnTo(value: string): string {
	if (!value.startsWith("/") || value.startsWith("//")) return "/";
	return value;
}
