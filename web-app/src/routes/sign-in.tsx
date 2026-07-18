import { createFileRoute } from "@tanstack/react-router";
import { DatabaseZap, LogIn } from "lucide-react";
import { useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { normalizeAuthReturnTo } from "~/lib/auth-return-to";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { localDevCredentials } from "~/lib/supabase";
import { peekWorkspaceShareJoinIntent } from "~/lib/workspace-share-capability";

interface SignInSearch {
	returnTo?: string;
}

export const Route = createFileRoute("/sign-in")({
	validateSearch: (search: Record<string, unknown>): SignInSearch =>
		typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {},
	component: SignInPage,
});

function SignInPage() {
	const { isLoaded, signInAsLocalDev, signInWithGoogle, user } = useAuth();
	const search = Route.useSearch();
	const returnTo = normalizeAuthReturnTo(search.returnTo ?? "/home");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const usesPreviewAccount = isDemoModeEnabled;
	const usesLocalAccount = Boolean(localDevCredentials) || usesPreviewAccount;
	const joiningSharedWorkspace =
		usesPreviewAccount && peekWorkspaceShareJoinIntent() !== null;

	const signIn = async () => {
		setSubmitting(true);
		setError(null);
		try {
			if (usesLocalAccount) {
				await signInAsLocalDev(joiningSharedWorkspace ? "recipient" : "owner");
				window.location.replace(returnTo);
			} else {
				await signInWithGoogle(returnTo);
			}
		} catch (signInError) {
			setError(
				signInError instanceof Error ? signInError.message : "Sign-in failed",
			);
			setSubmitting(false);
		}
	};

	return (
		<main className="grid min-h-screen place-items-center bg-[var(--color-bg-app)] px-5 py-8 text-[var(--color-text-primary)]">
			<div className="grid w-full max-w-[620px] justify-items-center gap-5 rounded-[8px] border border-[var(--color-border-panel)] bg-[var(--color-bg-panel)] p-7 shadow-[var(--shadow-md)]">
				<a
					href="/"
					className="inline-flex items-center gap-2.5 font-[750] tracking-normal no-underline"
					aria-label="LixRay home"
				>
					<span className="grid size-7 place-items-center rounded-[7px] bg-[var(--color-bg-action-secondary)] text-[var(--color-text-on-action-secondary)]">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>LixRay</span>
				</a>
				<div className="grid gap-2 text-center">
					<h1 className="m-0 text-2xl leading-[1.2] tracking-normal">
						Sign in to LixRay
					</h1>
					<p className="m-0 text-[var(--color-text-tertiary)]">
						{usesPreviewAccount
							? joiningSharedWorkspace
								? "Use the preview test account to join this workspace."
								: "Use the preview test account to continue."
							: localDevCredentials
								? "Use the seeded local development account."
								: "Use your Google account to continue."}
					</p>
				</div>
				{user && !usesLocalAccount ? (
					<a
						className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] no-underline transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] min-[801px]:w-auto"
						href={returnTo}
					>
						Continue to LixRay
					</a>
				) : (
					<button
						className="inline-flex min-h-[38px] w-full max-w-[320px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] disabled:cursor-not-allowed disabled:opacity-55"
						type="button"
						disabled={!isLoaded || submitting}
						onClick={() => void signIn()}
					>
						<LogIn size={17} aria-hidden="true" />
						{submitting
							? usesLocalAccount
								? "Signing in..."
								: "Redirecting..."
							: usesPreviewAccount
								? joiningSharedWorkspace
									? "Join as preview user"
									: "Continue as preview user"
								: localDevCredentials
									? "Continue as local developer"
									: "Continue with Google"}
					</button>
				)}
				{error ? (
					<p className="mt-3.5 whitespace-pre-wrap rounded-[8px] border border-[var(--color-error-200)] bg-[var(--color-error-50)] px-3.5 py-3 text-[var(--color-error-800)]">
						{error}
					</p>
				) : null}
			</div>
		</main>
	);
}
