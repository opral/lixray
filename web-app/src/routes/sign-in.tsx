import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DatabaseZap, LogIn } from "lucide-react";
import { useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { localDevCredentials } from "~/lib/supabase";

export const Route = createFileRoute("/sign-in")({
	component: SignInPage,
});

function SignInPage() {
	const { isLoaded, signInAsLocalDev, signInWithGoogle, user } = useAuth();
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const signIn = async () => {
		setSubmitting(true);
		setError(null);
		try {
			if (localDevCredentials) {
				await signInAsLocalDev();
				await navigate({ to: "/" });
			} else {
				await signInWithGoogle("/");
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
					aria-label="Lixray home"
				>
					<span className="grid size-7 place-items-center rounded-[7px] bg-[var(--color-bg-action-secondary)] text-[var(--color-text-on-action-secondary)]">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</a>
				<div className="grid gap-2 text-center">
					<h1 className="m-0 text-2xl leading-[1.2] tracking-normal">
						Sign in to Lixray
					</h1>
					<p className="m-0 text-[var(--color-text-tertiary)]">
						{localDevCredentials
							? "Use the seeded local development account."
							: "Use your Google account to continue."}
					</p>
				</div>
				{user && !localDevCredentials ? (
					<Link
						className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] no-underline transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] min-[801px]:w-auto"
						to="/"
					>
						Continue to Lixray
					</Link>
				) : (
					<button
						className="inline-flex min-h-[38px] w-full max-w-[320px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] disabled:cursor-not-allowed disabled:opacity-55"
						type="button"
						disabled={!isLoaded || submitting}
						onClick={() => void signIn()}
					>
						<LogIn size={17} aria-hidden="true" />
						{submitting
							? localDevCredentials
								? "Signing in..."
								: "Redirecting..."
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
