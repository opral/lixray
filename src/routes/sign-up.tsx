import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { DatabaseZap } from "lucide-react";

export const Route = createFileRoute("/sign-up")({
	component: SignUpPage,
});

export function SignUpPage() {
	return (
		<main className="auth-page">
			<div className="auth-card">
				<a href="/" className="brand" aria-label="Lixray home">
					<span className="brand-mark">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</a>
				<SignUp
					routing="path"
					path="/sign-up"
					signInUrl="/sign-in"
					forceRedirectUrl="/"
				/>
			</div>
		</main>
	);
}
