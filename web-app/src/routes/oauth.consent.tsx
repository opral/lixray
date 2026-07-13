import { createFileRoute } from "@tanstack/react-router";
import { DatabaseZap, LogIn, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "~/components/auth-provider";

interface ConsentSearch {
	authorization_id?: string;
}

interface ConsentDetails {
	authorizationId: string;
	clientName: string;
	clientUri: string | null;
	redirectUri: string;
	scopes: Array<string>;
}

export const Route = createFileRoute("/oauth/consent")({
	validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
		authorization_id:
			typeof search.authorization_id === "string"
				? search.authorization_id
				: undefined,
	}),
	component: OAuthConsentPage,
});

function OAuthConsentPage() {
	const { authorization_id: authorizationId } = Route.useSearch();
	const { client, isLoaded, signInWithGoogle, user } = useAuth();
	const [details, setDetails] = useState<ConsentDetails | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
	const returnTo = useMemo(
		() =>
			authorizationId
				? `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`
				: "/oauth/consent",
		[authorizationId],
	);

	useEffect(() => {
		if (!isLoaded || !user || !client) return;
		if (!authorizationId) {
			setError("The authorization request is missing its identifier.");
			return;
		}
		let disposed = false;
		void client.auth.oauth
			.getAuthorizationDetails(authorizationId)
			.then(({ data, error: detailsError }) => {
				if (disposed) return;
				if (detailsError || !data) {
					setError(
						detailsError?.message ??
							"Unable to load the authorization request.",
					);
					return;
				}
				if ("redirect_url" in data) {
					window.location.replace(data.redirect_url);
					return;
				}
				setDetails({
					authorizationId: data.authorization_id,
					clientName: data.client.name || "ChatGPT",
					clientUri: safeHttpsUrl(data.client.uri),
					redirectUri: data.redirect_uri,
					scopes: data.scope.split(/\s+/).filter(Boolean),
				});
			});
		return () => {
			disposed = true;
		};
	}, [authorizationId, client, isLoaded, user]);

	const decide = async (decision: "approve" | "deny") => {
		if (!client || !details) return;
		setSubmitting(decision);
		setError(null);
		const result = await client.auth.oauth[
			decision === "approve" ? "approveAuthorization" : "denyAuthorization"
		](details.authorizationId, { skipBrowserRedirect: true });
		if (result.error || !result.data?.redirect_url) {
			setError(result.error?.message ?? "Unable to complete authorization.");
			setSubmitting(null);
			return;
		}
		window.location.replace(result.data.redirect_url);
	};

	return (
		<main className="grid min-h-screen place-items-center bg-[var(--color-bg-app)] px-5 py-8 text-[var(--color-text-primary)]">
			<div className="grid w-full max-w-[620px] justify-items-stretch gap-5 rounded-[8px] border border-[var(--color-border-panel)] bg-[var(--color-bg-panel)] p-7 shadow-[var(--shadow-md)]">
				<a
					href="/"
					className="inline-flex items-center gap-2.5 justify-self-center font-[750] tracking-normal no-underline"
					aria-label="LixRay home"
				>
					<span className="grid size-7 place-items-center rounded-[7px] bg-[var(--color-bg-action-secondary)] text-[var(--color-text-on-action-secondary)]">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>LixRay</span>
				</a>
				<div className="grid justify-self-center gap-2 text-center">
					<ShieldCheck
						size={28}
						className="justify-self-center text-[var(--color-icon-brand)]"
						aria-hidden="true"
					/>
					<h1 className="m-0 text-2xl leading-[1.2] tracking-normal">
						Connect LixRay to ChatGPT
					</h1>
					<p className="m-0 text-[var(--color-text-tertiary)]">
						Authorize a private MCP connection using your existing LixRay
						account.
					</p>
					<p className="m-0 max-w-[480px] text-sm text-[var(--color-text-tertiary)]">
						This authorization is separate from your LixRay browser session.
						Being signed in to the website does not automatically connect your
						MCP client.
					</p>
				</div>

				{!isLoaded ? (
					<p className="text-sm text-[var(--color-text-tertiary)]">
						Loading account…
					</p>
				) : null}
				{isLoaded && !user ? (
					<button
						className="inline-flex min-h-[38px] w-full max-w-[320px] cursor-pointer items-center justify-center justify-self-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)]"
						type="button"
						onClick={() => void signInWithGoogle(returnTo)}
					>
						<LogIn size={17} aria-hidden="true" />
						Continue with Google
					</button>
				) : null}

				{details ? (
					<>
						<section
							className="rounded-[8px] border border-[var(--color-border-panel)] p-4"
							aria-label="Connection request"
						>
							<p className="m-0">
								<strong>{details.clientName}</strong> is requesting access to
								your LixRay account.
							</p>
							{details.clientUri ? (
								<a
									href={details.clientUri}
									className="mt-1.5 inline-block text-[13px] text-[var(--color-text-link)] hover:text-[var(--color-text-link-hover)]"
									target="_blank"
									rel="noreferrer"
								>
									{details.clientUri}
								</a>
							) : null}
						</section>
						<section
							className="rounded-[8px] border border-[var(--color-border-panel)] p-4"
							aria-label="Permissions"
						>
							<h2 className="mb-2.5 mt-0 text-base">
								This connection will be able to:
							</h2>
							<ul className="mb-3 mt-0 pl-5 leading-[1.55] text-[var(--color-text-secondary)]">
								<li>
									List your accessible organizations, workspaces, and branches.
								</li>
								<li>Create and edit files and directories.</li>
							</ul>
							<p className="m-0 text-[var(--color-text-tertiary)]">
								Requested OAuth scopes: {details.scopes.join(", ") || "none"}
							</p>
						</section>
						<div className="flex justify-end gap-2.5">
							<button
								className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-border-panel)] bg-[var(--color-bg-panel)] px-3.5 font-[680] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] disabled:cursor-not-allowed disabled:opacity-55 min-[801px]:w-auto"
								type="button"
								disabled={submitting !== null}
								onClick={() => void decide("deny")}
							>
								{submitting === "deny" ? "Denying…" : "Deny"}
							</button>
							<button
								className="inline-flex min-h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-[var(--color-bg-action-primary)] bg-[var(--color-bg-action-primary)] px-3.5 font-[680] text-[var(--color-text-on-action-primary)] transition-colors hover:border-[var(--color-bg-action-primary-hover)] hover:bg-[var(--color-bg-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring-focus-visible)] disabled:cursor-not-allowed disabled:opacity-55 min-[801px]:w-auto"
								type="button"
								disabled={submitting !== null}
								onClick={() => void decide("approve")}
							>
								{submitting === "approve" ? "Connecting…" : "Allow and connect"}
							</button>
						</div>
						<p className="text-center text-xs text-[var(--color-text-tertiary)]">
							After approval you will return to{" "}
							{displayOrigin(details.redirectUri)}. The client must finish
							saving its MCP credentials before the connection is ready.
						</p>
					</>
				) : null}

				{error ? (
					<p className="mt-3.5 whitespace-pre-wrap rounded-[8px] border border-[var(--color-error-200)] bg-[var(--color-error-50)] px-3.5 py-3 text-[var(--color-error-800)]">
						{error}
					</p>
				) : null}
			</div>
		</main>
	);
}

function safeHttpsUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

function displayOrigin(value: string): string {
	try {
		return new URL(value).origin;
	} catch {
		return "the requesting app";
	}
}
