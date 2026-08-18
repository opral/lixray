import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { peekAuthReturnTo, takeAuthReturnTo } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
import { getBrowserSupabaseClient } from "~/lib/supabase";
import {
	markRepositoryShareJoined,
	peekRepositoryShareCapability,
	stageRepositoryShareJoinError,
	takeRepositoryShareJoinIntent,
	takeRepositoryShareCapability,
} from "~/lib/repository-share-capability";
import { captureTelemetryImmediately } from "~/lib/telemetry";

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
			.then(async ({ data: sessionData, error: exchangeError }) => {
				if (disposed) return;
				if (exchangeError) {
					setError(exchangeError.message);
					return;
				}

				// Track user_signed_up event for first-time users only
				const userId = sessionData?.user?.id;
				if (userId) {
					const signupKey = `lixray.signup.${userId}`;
					const hasTrackedSignup = window.localStorage.getItem(signupKey);
					if (!hasTrackedSignup) {
						const returnTo = peekAuthReturnTo();
						await captureTelemetryImmediately("user_signed_up", {
							auth_provider: "google",
							signup_source: returnTo === "/open" ? "direct" : returnTo,
						});
						window.localStorage.setItem(signupKey, "true");
					}
				}

				const capability = peekRepositoryShareCapability();
				const joinRepositoryId = takeRepositoryShareJoinIntent();
				if (capability && joinRepositoryId === capability.repositoryId) {
					try {
						const { error: acceptError } = await getBrowserSupabaseClient().rpc(
							"accept_lix_share_token",
							{ p_token: capability.token },
						);
						if (acceptError) {
							stageRepositoryShareJoinError(
								`${acceptError.message} Select Join to edit to try again.`,
							);
						} else {
							takeRepositoryShareCapability();
							markRepositoryShareJoined(capability.repositoryId);
						}
					} catch (caught) {
						stageRepositoryShareJoinError(
							`${caught instanceof Error ? caught.message : "Unable to join this repository."} Select Join to edit to try again.`,
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

	// The success state is chrome-free — the user sees it for a beat before
	// the redirect; errors are terminal here, so they get a real card (1c).
	return (
		<main className="grid min-h-screen place-items-center bg-bg-app px-5 py-8 text-text-primary">
			{error ? (
				<div className="grid w-full max-w-[400px] justify-items-center gap-[18px] rounded-[14px] border border-border-panel bg-bg-panel px-7 py-8 text-center shadow-[0_18px_50px_rgba(28,25,23,0.1)]">
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					<h1 className="m-0 text-[19px] leading-tight font-bold">
						Unable to sign in
					</h1>
					<p className="m-0 w-full whitespace-pre-wrap rounded-[9px] border border-error-200 bg-error-50 px-3.5 py-3 text-left text-[12.5px] leading-[1.55] text-error-800">
						{error}
					</p>
					<Button
						asChild
						variant="featured"
						className="h-auto w-full rounded-[9px] py-2.75 text-[13.5px] font-bold"
					>
						<a
							href={`/sign-in?returnTo=${encodeURIComponent(peekAuthReturnTo())}`}
						>
							Try again
						</a>
					</Button>
					<a
						href="/"
						className="text-[12.5px] font-semibold text-text-link hover:text-text-link-hover"
					>
						Back to lixray.com
					</a>
				</div>
			) : (
				<div className="flex flex-col items-center gap-[18px]">
					<img
						src="/lixray-mark.svg"
						alt=""
						className="size-[34px] opacity-90"
					/>
					<h1 className="m-0 text-sm font-semibold text-text-secondary">
						Completing sign-in…
					</h1>
					<span
						aria-hidden="true"
						className="relative h-[3px] w-[120px] overflow-hidden rounded-[2px] bg-[#E4DDD1]"
					>
						<span className="absolute inset-y-0 left-0 w-14 rounded-[2px] bg-bg-action-primary opacity-70 animate-auth-progress motion-reduce:animate-none" />
					</span>
				</div>
			)}
		</main>
	);
}
