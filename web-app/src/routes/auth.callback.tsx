import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { takeAuthReturnTo } from "~/components/auth-provider";
import { getBrowserSupabaseClient } from "~/lib/supabase";

interface CallbackSearch {
	code?: string;
	error?: string;
	error_description?: string;
}

export const Route = createFileRoute("/auth/callback")({
	validateSearch: (search: Record<string, unknown>): CallbackSearch => ({
		code: typeof search.code === "string" ? search.code : undefined,
		error: typeof search.error === "string" ? search.error : undefined,
		error_description:
			typeof search.error_description === "string"
				? search.error_description
				: undefined,
	}),
	component: AuthCallbackPage,
});

function AuthCallbackPage() {
	const search = Route.useSearch();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (search.error) {
			setError(search.error_description ?? search.error);
			return;
		}
		if (!search.code) {
			setError("The authentication callback did not include a code.");
			return;
		}

		let disposed = false;
		void getBrowserSupabaseClient()
			.auth.exchangeCodeForSession(search.code)
			.then(({ error: exchangeError }) => {
				if (disposed) return;
				if (exchangeError) {
					setError(exchangeError.message);
					return;
				}
				window.location.replace(takeAuthReturnTo());
			});

		return () => {
			disposed = true;
		};
	}, [search.code, search.error, search.error_description]);

	return (
		<main className="workspace-empty">
			<div className="workspace-empty-inner">
				<p className="eyebrow">Authentication</p>
				<h1>{error ? "Unable to sign in" : "Completing sign-in..."}</h1>
				{error ? <p className="error-box">{error}</p> : null}
			</div>
		</main>
	);
}
