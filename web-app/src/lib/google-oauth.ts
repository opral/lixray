import type { SignInWithOAuthCredentials } from "@supabase/supabase-js";

export function googleOAuthSignInCredentials(
	origin: string,
): SignInWithOAuthCredentials {
	return {
		provider: "google",
		options: {
			redirectTo: `${origin}/auth/callback`,
			queryParams: {
				prompt: "select_account",
			},
		},
	};
}
