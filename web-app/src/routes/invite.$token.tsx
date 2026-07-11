import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";

export const Route = createFileRoute("/invite/$token")({
	component: InvitationPage,
});

function InvitationPage() {
	const { token } = Route.useParams();
	const { client, isLoaded, signInWithGoogle, signOut, user } = useAuth();
	const workspaceState = useWorkspace();
	const attempted = useRef(false);
	const [status, setStatus] = useState<
		"waiting" | "accepting" | "accepted" | "error"
	>("waiting");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!isLoaded || !client || !user || attempted.current) return;
		attempted.current = true;
		setStatus("accepting");
		void client
			.rpc("accept_organization_invitation", { p_token: token })
			.then(async ({ data, error: acceptError }) => {
				if (acceptError) {
					setError(acceptError.message);
					setStatus("error");
					return;
				}
				await workspaceState.refresh({ organizationId: String(data) });
				setStatus("accepted");
			});
	}, [client, isLoaded, token, user, workspaceState]);

	return (
		<main className="workspace-empty">
			<div className="workspace-empty-inner">
				<p className="eyebrow">Organization invitation</p>
				{!isLoaded ? (
					<h1>Loading...</h1>
				) : !user ? (
					<>
						<h1>Sign in to accept this invitation.</h1>
						<p className="copy">
							Use the Google account whose email address was invited.
						</p>
						<div className="toolbar">
							<button
								className="button primary"
								onClick={() => void signInWithGoogle(`/invite/${token}`)}
							>
								Continue with Google
							</button>
						</div>
					</>
				) : status === "accepted" ? (
					<>
						<h1>Invitation accepted.</h1>
						<div className="toolbar">
							<Link className="button primary" to="/">
								Open workspace
							</Link>
						</div>
					</>
				) : status === "error" ? (
					<>
						<h1>Unable to accept invitation.</h1>
						<p className="error-box">{error}</p>
						<div className="toolbar">
							<button className="button" onClick={() => void signOut()}>
								Sign out and use another Google account
							</button>
						</div>
					</>
				) : (
					<h1>Accepting invitation...</h1>
				)}
			</div>
		</main>
	);
}
