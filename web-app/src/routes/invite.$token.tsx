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
		<main className="grid min-h-[calc(100vh-80px)] place-items-center bg-[var(--color-bg-app)] px-5 py-10 text-[var(--color-text-primary)]">
			<div className="w-full max-w-[620px] rounded-[8px] border border-[var(--color-border-panel)] bg-[var(--color-bg-panel)] p-7 shadow-[var(--shadow-md)]">
				<p className="mb-2 mt-0 text-[13px] font-[760] uppercase tracking-[0.08em] text-[var(--color-text-link)]">
					Organization invitation
				</p>
				{!isLoaded ? (
					<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
						Loading...
					</h1>
				) : !user ? (
					<>
						<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
							Sign in to accept this invitation.
						</h1>
						<p className="mt-3 max-w-[660px] text-[17px] leading-[1.55] text-[var(--color-text-tertiary)]">
							Use the Google account whose email address was invited.
						</p>
						<div className="mt-3 flex flex-col items-stretch justify-between gap-3 min-[801px]:flex-row min-[801px]:items-center">
							<button
								className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] min-[801px]:w-auto"
								onClick={() => void signInWithGoogle(`/invite/${token}`)}
							>
								Continue with Google
							</button>
						</div>
					</>
				) : status === "accepted" ? (
					<>
						<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
							Invitation accepted.
						</h1>
						<div className="mt-3 flex flex-col items-stretch justify-between gap-3 min-[801px]:flex-row min-[801px]:items-center">
							<Link
								className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] no-underline transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] min-[801px]:w-auto"
								to="/"
							>
								Open workspace
							</Link>
						</div>
					</>
				) : status === "error" ? (
					<>
						<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
							Unable to accept invitation.
						</h1>
						<p className="mt-3.5 whitespace-pre-wrap rounded-[8px] border border-[var(--color-error-200)] bg-[var(--color-error-50)] px-3.5 py-3 text-[var(--color-error-800)]">
							{error}
						</p>
						<div className="mt-3 flex flex-col items-stretch justify-between gap-3 min-[801px]:flex-row min-[801px]:items-center">
							<button
								className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-border-panel)] bg-[var(--color-bg-panel)] px-3.5 font-[680] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] min-[801px]:w-auto"
								onClick={() => void signOut()}
							>
								Sign out and use another Google account
							</button>
						</div>
					</>
				) : (
					<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
						Accepting invitation...
					</h1>
				)}
			</div>
		</main>
	);
}
