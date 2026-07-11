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
		<main className="auth-page">
			<div className="auth-card">
				<a href="/" className="brand" aria-label="Lixray home">
					<span className="brand-mark">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</a>
				<div className="auth-copy">
					<h1>Sign in to Lixray</h1>
					<p className="muted">
						{localDevCredentials
							? "Use the seeded local development account."
							: "Use your Google account to continue."}
					</p>
				</div>
				{user ? (
					<Link className="button primary" to="/">
						Continue to Lixray
					</Link>
				) : (
					<button
						className="button primary auth-action"
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
				{error ? <p className="error-box">{error}</p> : null}
			</div>
		</main>
	);
}
