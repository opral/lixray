import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { takeAuthReturnTo } from "~/components/auth-provider";
import { getBrowserSupabaseClient } from "~/lib/supabase";
import {
	markWorkspaceShareJoined,
	peekWorkspaceShareCapability,
	stageWorkspaceShareJoinError,
	takeWorkspaceShareJoinIntent,
	takeWorkspaceShareCapability,
} from "~/lib/workspace-share-capability";

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
			.then(async ({ error: exchangeError }) => {
				if (disposed) return;
				if (exchangeError) {
					setError(exchangeError.message);
					return;
				}
				const capability = peekWorkspaceShareCapability();
				const joinWorkspaceId = takeWorkspaceShareJoinIntent();
				if (capability && joinWorkspaceId === capability.workspaceId) {
					try {
						const { error: acceptError } = await getBrowserSupabaseClient().rpc(
							"accept_workspace_share_token",
							{ p_token: capability.token },
						);
						if (acceptError) {
							stageWorkspaceShareJoinError(
								`${acceptError.message} Select Join to edit to try again.`,
							);
						} else {
							takeWorkspaceShareCapability();
							markWorkspaceShareJoined(capability.workspaceId);
						}
					} catch (caught) {
						stageWorkspaceShareJoinError(
							`${caught instanceof Error ? caught.message : "Unable to join this workspace."} Select Join to edit to try again.`,
						);
					}
				}
				if (disposed) return;
				window.location.replace(takeAuthReturnTo());
			})
			.catch((caught: unknown) => {
				if (!disposed) {
					setError(
						caught instanceof Error
							? caught.message
							: "Unable to complete sign-in.",
					);
				}
			});

		return () => {
			disposed = true;
		};
	}, [search.code, search.error, search.error_description]);

	return (
		<main className="grid min-h-[calc(100vh-80px)] place-items-center bg-[var(--color-bg-app)] px-5 py-10 text-[var(--color-text-primary)]">
			<div className="w-full max-w-[620px] rounded-[8px] border border-[var(--color-border-panel)] bg-[var(--color-bg-panel)] p-7 shadow-[var(--shadow-md)]">
				<p className="mb-2 mt-0 text-[13px] font-[760] uppercase tracking-[0.08em] text-[var(--color-text-link)]">
					Authentication
				</p>
				<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
					{error ? "Unable to sign in" : "Completing sign-in..."}
				</h1>
				{error ? (
					<p className="mt-3.5 whitespace-pre-wrap rounded-[8px] border border-[var(--color-error-200)] bg-[var(--color-error-50)] px-3.5 py-3 text-[var(--color-error-800)]">
						{error}
					</p>
				) : null}
			</div>
		</main>
	);
}
