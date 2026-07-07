import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { DatabaseZap } from "lucide-react";

export const Route = createFileRoute("/sign-in")({
	component: SignInPage,
});

export function SignInPage() {
	return (
		<main className="auth-page">
			<div className="auth-card">
				<a href="/" className="brand" aria-label="Lixray home">
					<span className="brand-mark">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</a>
				<SignIn
					routing="path"
					path="/sign-in"
					signUpUrl="/sign-up"
					forceRedirectUrl="/"
				/>
			</div>
		</main>
	);
}
