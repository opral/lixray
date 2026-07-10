import { createFileRoute, Link } from "@tanstack/react-router";
import { DatabaseZap, LogIn } from "lucide-react";
import { useState } from "react";
import { useAuth } from "~/components/auth-provider";

export const Route = createFileRoute("/sign-in")({
	component: SignInPage,
});

export function SignInPage() {
	const { isLoaded, signInWithGoogle, user } = useAuth();
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const signIn = async () => {
		setSubmitting(true);
		setError(null);
		try {
			await signInWithGoogle("/");
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
					<p className="muted">Use your Google account to continue.</p>
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
						{submitting ? "Redirecting..." : "Continue with Google"}
					</button>
				)}
				{error ? <p className="error-box">{error}</p> : null}
			</div>
		</main>
	);
}
