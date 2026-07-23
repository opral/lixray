import { createFileRoute } from "@tanstack/react-router";
import { LogIn, PencilLine } from "lucide-react";
import { useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
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
	const returnTo = normalizeAuthReturnTo(search.returnTo ?? "/open");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const usesPreviewAccount = isDemoModeEnabled;
	const usesLocalAccount = Boolean(localDevCredentials) || usesPreviewAccount;
	const joiningSharedWorkspace =
		usesPreviewAccount && peekWorkspaceShareJoinIntent() !== null;
	const usesGoogle = !usesLocalAccount;

	const signIn = async () => {
		setSubmitting(true);
		setError(null);
		try {
			if (usesLocalAccount) {
				await signInAsLocalDev();
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
		<main className="grid min-h-screen place-items-center bg-bg-app px-5 py-8 text-text-primary">
			<div className="grid w-full max-w-[400px] justify-items-center gap-6 rounded-xl border border-border-panel bg-bg-panel px-7 py-9 shadow-[0_18px_50px_rgba(28,25,23,0.1),0_2px_8px_rgba(28,25,23,0.05)]">
				<a
					href="/"
					className="inline-flex items-center gap-2 font-[750] no-underline"
					aria-label="LixRay home"
				>
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					<span>LixRay</span>
				</a>
				<div className="grid gap-2 text-center">
					<h1 className="m-0 text-xl font-bold leading-tight">
						{joiningSharedWorkspace ? "Join to edit" : "Sign in to LixRay"}
					</h1>
					<p className="m-0 text-sm leading-normal text-text-tertiary">
						{usesPreviewAccount
							? joiningSharedWorkspace
								? "Sign in with the preview test account and you’ll land back on the shared file, ready to edit."
								: "Use the preview test account to continue."
							: localDevCredentials
								? "Use the seeded local development account."
								: joiningSharedWorkspace
									? "Sign in with Google and you’ll land back on the shared file, ready to edit."
									: "Use your Google account to continue."}
					</p>
				</div>
				{user && !usesLocalAccount ? (
					<Button asChild variant="featured" className="w-full font-semibold">
						<a href={returnTo}>Continue to LixRay</a>
					</Button>
				) : (
					<Button
						type="button"
						variant="featured"
						className="w-full font-semibold"
						disabled={!isLoaded || submitting}
						onClick={() => void signIn()}
					>
						{usesGoogle ? (
							<GoogleMark />
						) : joiningSharedWorkspace ? (
							<PencilLine aria-hidden="true" />
						) : (
							<LogIn aria-hidden="true" />
						)}
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
					</Button>
				)}
				{error ? (
					<p className="whitespace-pre-wrap rounded-lg border border-error-200 bg-error-50 px-3.5 py-3 text-sm text-error-800">
						{error}
					</p>
				) : null}
			</div>
		</main>
	);
}

/** Google’s four-color “G”, rendered on a white coin for contrast. */
function GoogleMark() {
	return (
		<span
			aria-hidden="true"
			className="grid size-[18px] shrink-0 place-items-center rounded-full bg-white"
		>
			<svg viewBox="0 0 24 24" className="size-3">
				<path
					fill="#4285F4"
					d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
				/>
				<path
					fill="#34A853"
					d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"
				/>
				<path
					fill="#FBBC05"
					d="M5.28 14.28a7.21 7.21 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z"
				/>
				<path
					fill="#EA4335"
					d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.98 11.98 0 0 0 1.27 6.6l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
				/>
			</svg>
		</span>
	);
}
