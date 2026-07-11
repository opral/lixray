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
		<main className="auth-page">
			<div className="auth-card consent-card">
				<a href="/" className="brand" aria-label="Lixray home">
					<span className="brand-mark">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</a>
				<div className="auth-copy">
					<ShieldCheck size={28} aria-hidden="true" />
					<h1>Connect Lixray to ChatGPT</h1>
					<p className="muted">
						Authorize a private MCP connection using your existing Lixray
						account.
					</p>
				</div>

				{!isLoaded ? <p className="status-line">Loading account…</p> : null}
				{isLoaded && !user ? (
					<button
						className="button primary auth-action"
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
							className="consent-request"
							aria-label="Connection request"
						>
							<p>
								<strong>{details.clientName}</strong> is requesting access to
								your Lixray account.
							</p>
							{details.clientUri ? (
								<a href={details.clientUri} target="_blank" rel="noreferrer">
									{details.clientUri}
								</a>
							) : null}
						</section>
						<section className="consent-permissions" aria-label="Permissions">
							<h2>This connection will be able to:</h2>
							<ul>
								<li>
									List your accessible organizations, workspaces, and branches.
								</li>
								<li>Create and edit files and directories.</li>
							</ul>
							<p className="muted">
								Requested OAuth scopes: {details.scopes.join(", ") || "none"}
							</p>
						</section>
						<div className="consent-actions">
							<button
								className="button"
								type="button"
								disabled={submitting !== null}
								onClick={() => void decide("deny")}
							>
								{submitting === "deny" ? "Denying…" : "Deny"}
							</button>
							<button
								className="button primary"
								type="button"
								disabled={submitting !== null}
								onClick={() => void decide("approve")}
							>
								{submitting === "approve" ? "Connecting…" : "Allow and connect"}
							</button>
						</div>
						<p className="consent-redirect muted">
							After approval you will return to{" "}
							{displayOrigin(details.redirectUri)}.
						</p>
					</>
				) : null}

				{error ? <p className="error-box">{error}</p> : null}
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
