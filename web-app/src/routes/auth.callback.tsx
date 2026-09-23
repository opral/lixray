import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { peekAuthReturnTo, takeAuthReturnTo } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
import { getBrowserSupabaseClient } from "~/lib/supabase";
import { ensureInitialPersonalRepository } from "~/lib/initial-personal-repository";
import {
	markRepositoryShareJoined,
	peekRepositoryShareCapability,
	stageRepositoryShareJoinError,
	takeRepositoryShareJoinIntent,
	takeRepositoryShareCapability,
} from "~/lib/repository-share-capability";
import { reportUserSignedUp } from "~/lib/signup-telemetry";

interface CallbackSearch {
	code?: string;
	error?: string;
	error_description?: string;
}

const exchangeCode = (code: string) =>
	getBrowserSupabaseClient().auth.exchangeCodeForSession(code);
let pendingExchange: {
	code: string;
	promise: ReturnType<typeof exchangeCode>;
} | null = null;

function exchangeCodeOnce(code: string) {
	if (pendingExchange?.code === code) return pendingExchange.promise;
	const promise = exchangeCode(code);
	pendingExchange = { code, promise };
	return promise;
}

async function finishBrowserSignup(accessToken: string) {
	const result = await ensureInitialPersonalRepository(
		getBrowserSupabaseClient(),
		accessToken,
		window.location.origin,
	);
	const returnTo = takeAuthReturnTo();
	window.location.replace(
		returnTo === "/open" && result.created && result.path
			? result.path
			: returnTo,
	);
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
	const [setupRetryable, setSetupRetryable] = useState(false);
	const retrySetup = async () => {
		setError(null);
		try {
			const { data, error: sessionError } =
				await getBrowserSupabaseClient().auth.getSession();
			if (sessionError) throw sessionError;
			if (!data.session) throw new Error("Sign in again to finish setup.");
			await finishBrowserSignup(data.session.access_token);
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: "Unable to set up your repository.",
			);
		}
	};

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
		void exchangeCodeOnce(search.code)
			.then(async ({ data: sessionData, error: exchangeError }) => {
				if (disposed) return;
				if (exchangeError) {
					setError(exchangeError.message);
					return;
				}

				// The authenticated server decides whether this was account creation and
				// emits the same canonical event for web and MCP-originated signups.
				if (sessionData.session) {
					try {
						await reportUserSignedUp(sessionData.session, peekAuthReturnTo());
					} catch (telemetryError: unknown) {
						console.warn("Failed to report signup telemetry", telemetryError);
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
				if (!sessionData.session) {
					setError("Sign in again to finish setup.");
					return;
				}
				try {
					if (
						new URL(peekAuthReturnTo(), window.location.origin).pathname ===
						"/oauth/consent"
					) {
						window.location.replace(takeAuthReturnTo());
						return;
					}
					await finishBrowserSignup(sessionData.session.access_token);
				} catch (setupError) {
					if (!disposed) {
						setSetupRetryable(true);
						setError(
							setupError instanceof Error
								? setupError.message
								: "Unable to set up your repository.",
						);
					}
				}
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
		<main className="grid min-h-screen place-items-center bg-bg px-5 py-8 text-fg">
			{error ? (
				<div className="grid w-full max-w-[400px] justify-items-center gap-[18px] rounded-[14px] border border-border bg-panel px-7 py-8 text-center shadow-[0_18px_50px_color-mix(in_srgb,var(--atelier-overlay)_10%,transparent)]">
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					<h1 className="m-0 text-[19px] leading-tight font-bold">
						Unable to sign in
					</h1>
					<p className="m-0 w-full whitespace-pre-wrap rounded-[9px] border border-danger-subtle bg-danger-subtle px-3.5 py-3 text-left text-[12.5px] leading-[1.55] text-diff-removed">
						{error}
					</p>
					<Button
						asChild
						variant="featured"
						className="h-auto w-full rounded-[9px] py-2.75 text-[13.5px] font-bold"
					>
						{setupRetryable ? (
							<button type="button" onClick={() => void retrySetup()}>
								Retry setup
							</button>
						) : (
							<a
								href={`/sign-in?returnTo=${encodeURIComponent(peekAuthReturnTo())}`}
							>
								Try again
							</a>
						)}
					</Button>
					<a
						href="/"
						className="text-[12.5px] font-semibold text-link hover:text-link-hover"
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
					<h1 className="m-0 text-sm font-semibold text-fg-muted">
						Completing sign-in…
					</h1>
					<span
						aria-hidden="true"
						className="relative h-[3px] w-[120px] overflow-hidden rounded-[2px] bg-border-strong"
					>
						<span className="absolute inset-y-0 left-0 w-14 rounded-[2px] bg-accent opacity-70 animate-auth-progress motion-reduce:animate-none" />
					</span>
				</div>
			)}
		</main>
	);
}
