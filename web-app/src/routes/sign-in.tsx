import { createFileRoute } from "@tanstack/react-router";
import { LogIn, PencilLine } from "lucide-react";
import { useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { GoogleMark } from "~/components/google-mark";
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
			<div className="grid w-full max-w-[400px] justify-items-center gap-[22px] rounded-[14px] border border-border-panel bg-bg-panel px-7 py-9 shadow-[0_18px_50px_rgba(28,25,23,0.1),0_2px_8px_rgba(28,25,23,0.05)]">
				<a
					href="/"
					className="inline-flex items-center gap-2 text-[15px] font-[750] no-underline"
					aria-label="LixRay home"
				>
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					<span>LixRay</span>
				</a>
				<div className="grid gap-[7px] text-center">
					<h1 className="m-0 text-xl font-bold leading-tight">
						{joiningSharedWorkspace ? "Join to edit" : "Sign in to LixRay"}
					</h1>
					<p className="m-0 text-[13.5px] leading-normal text-text-quaternary">
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
					<Button
						asChild
						variant="featured"
						className="h-auto w-full rounded-[10px] py-3 text-sm font-bold"
					>
						<a href={returnTo}>Continue to LixRay</a>
					</Button>
				) : (
					<Button
						type="button"
						variant="featured"
						className="h-auto w-full gap-2.5 rounded-[10px] py-3 text-sm font-bold"
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
