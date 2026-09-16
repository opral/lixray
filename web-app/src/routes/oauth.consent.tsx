import { createFileRoute } from "@tanstack/react-router";
import { Check, LogIn, Plug, X } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useAuth } from "~/components/auth-provider";
import { GoogleMark } from "~/components/google-mark";
import { Button } from "~/components/ui/button";
import {
	OAUTH_CONSENT_OPEN_HREF,
	keepsLixrayDocument,
	resolveOAuthConsentDecision,
} from "~/lib/oauth-consent";
import { localDevCredentials } from "~/lib/supabase";
import { captureTelemetryImmediately } from "~/lib/telemetry";

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
	const { client, isLoaded, signInAsLocalDev, signInWithGoogle, user } =
		useAuth();
	const [details, setDetails] = useState<ConsentDetails | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
	const [approved, setApproved] = useState(false);
	const [showOpenFallback, setShowOpenFallback] = useState(false);
	const [localSignInPending, setLocalSignInPending] = useState(false);
	const localSignInAttempted = useRef(false);
	const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingClientHop = useRef<Window | null>(null);
	const usesLocalAccount = Boolean(localDevCredentials);
	const returnTo = useMemo(
		() =>
			authorizationId
				? `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`
				: "/oauth/consent",
		[authorizationId],
	);
	const signInLocally = useCallback(async () => {
		setLocalSignInPending(true);
		setError(null);
		try {
			await signInAsLocalDev();
		} catch (signInError) {
			setError(
				signInError instanceof Error
					? signInError.message
					: "Local development sign-in failed.",
			);
			setLocalSignInPending(false);
		}
	}, [signInAsLocalDev]);

	useEffect(() => {
		if (
			!isLoaded ||
			user ||
			!usesLocalAccount ||
			localSignInAttempted.current
		) {
			return;
		}
		localSignInAttempted.current = true;
		void signInLocally();
	}, [isLoaded, signInLocally, user, usesLocalAccount]);

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

	useEffect(() => {
		return () => {
			if (fallbackTimer.current !== null) {
				clearTimeout(fallbackTimer.current);
			}
			pendingClientHop.current?.close();
			pendingClientHop.current = null;
		};
	}, []);

	const closePendingClientHop = () => {
		pendingClientHop.current?.close();
		pendingClientHop.current = null;
	};

	const decide = async (decision: "approve" | "deny") => {
		if (!client || !details) return;
		setSubmitting(decision);
		setError(null);
		if (decision === "approve" && keepsLixrayDocument(details.redirectUri)) {
			pendingClientHop.current = window.open("about:blank", "_blank");
		}
		const outcome = await resolveOAuthConsentDecision(
			{
				decision,
				authorizationId: details.authorizationId,
				clientName: details.clientName,
				oauth: client.auth.oauth,
			},
			{
				captureImmediately: captureTelemetryImmediately,
				navigate: (url) => {
					closePendingClientHop();
					if (decision === "approve") {
						window.location.assign(url);
						return;
					}
					window.location.replace(url);
				},
				openClientHop: (url) => {
					const hop = pendingClientHop.current;
					pendingClientHop.current = null;
					if (hop && !hop.closed) {
						hop.location.replace(url);
						return;
					}
					window.open(url, "_blank", "noopener,noreferrer");
				},
				scheduleFallback: (callback, delayMs) => {
					if (fallbackTimer.current !== null) {
						clearTimeout(fallbackTimer.current);
					}
					fallbackTimer.current = setTimeout(callback, delayMs);
				},
				onShowOpenFallback: () => {
					flushSync(() => {
						setApproved(true);
						setShowOpenFallback(true);
					});
				},
			},
		);
		if (!outcome.ok) {
			closePendingClientHop();
			setError(outcome.error);
			setSubmitting(null);
			return;
		}
		if (decision === "approve" && outcome.handoff === "leave-tab") {
			setApproved(true);
		}
	};

	const clientName = details?.clientName ?? "your agent";
	const signedOut = isLoaded && !user;
	const connected = approved || showOpenFallback;

	// The client-to-LixRay handshake is the headline (1g): agent glyph →
	// LixRay mark, scopes as three plain sentences, raw scopes behind a
	// title attribute. Signed-out keeps the same card and swaps the body
	// for one sign-in button that returns to this consent URL. After Allow,
	// HTTPS clients assign away and get a 2s /open fallback if this tab
	// stays. Loopback and custom-scheme clients keep this tab and show
	// Continue in LixRay immediately.
	return (
		<main className="grid min-h-screen place-items-center bg-bg px-5 py-8 text-fg">
			<div className="flex w-full max-w-[420px] flex-col gap-5 rounded-[14px] border border-border bg-panel px-7 pt-8 pb-6 shadow-[0_18px_50px_color-mix(in_srgb,var(--at-overlay)_10%,transparent),0_2px_8px_color-mix(in_srgb,var(--at-overlay)_5%,transparent)]">
				<div className="flex flex-col items-center gap-4">
					<div className="flex items-center gap-3.5" aria-hidden="true">
						<span className="inline-flex size-11 items-center justify-center rounded-[12px] bg-accent-subtle ring-1 ring-border ring-inset">
							{connected ? (
								<Check className="size-6 text-tag-green-fg" strokeWidth={2.4} />
							) : (
								<Plug className="size-6 text-fg-muted" />
							)}
						</span>
						<svg
							width="26"
							height="12"
							viewBox="0 0 26 12"
							fill="none"
							stroke="var(--at-fg-faint)"
							strokeWidth="2"
							strokeLinecap="round"
						>
							<path d="M2 6h22M20 2l4 4-4 4" />
						</svg>
						<img src="/lixray-mark.svg" alt="" className="size-10" />
					</div>
					<div className="flex flex-col gap-1.5 text-center">
						<h1 className="m-0 text-[20px] leading-tight font-bold tracking-[-0.01em]">
							{connected
								? `Connected to ${clientName}`
								: `Connect ${clientName} to LixRay`}
						</h1>
						{connected ? (
							<p className="m-0 text-[13.5px] leading-[1.55] text-fg-muted">
								{showOpenFallback
									? "If your agent didn’t open, continue in LixRay"
									: `Sending you back to ${displayOrigin(details?.redirectUri ?? "")}…`}
							</p>
						) : signedOut ? (
							<p className="m-0 text-[12.5px] leading-normal text-fg-faint">
								Sign in first — you’ll come right back to approve the
								connection.
							</p>
						) : details ? (
							<p className="m-0 text-[13.5px] leading-[1.55] text-fg-muted">
								<strong className="font-bold text-fg">
									{details.clientName}
								</strong>{" "}
								is asking to use your LixRay account.
								{details.clientUri ? (
									<>
										<br />
										<a
											href={details.clientUri}
											className="text-[12.5px] font-semibold text-link hover:text-link-hover"
											target="_blank"
											rel="noreferrer"
										>
											{displayHost(details.clientUri)}
										</a>
									</>
								) : null}
							</p>
						) : error ? null : (
							<p className="m-0 text-[13.5px] text-fg-faint">
								Loading the authorization request…
							</p>
						)}
					</div>
				</div>

				{signedOut && !connected ? (
					usesLocalAccount ? (
						<div className="flex flex-col items-center gap-3">
							<p className="m-0 text-[12.5px] text-fg-faint">
								{localSignInPending
									? "Signing in with the local development account…"
									: "Local development sign-in needs to be retried."}
							</p>
							{localSignInPending ? null : (
								<Button
									type="button"
									variant="featured"
									className="h-auto w-full gap-2.5 rounded-[9px] py-2.5 text-[13px] font-bold"
									onClick={() => void signInLocally()}
								>
									<LogIn aria-hidden="true" />
									Retry local sign-in
								</Button>
							)}
						</div>
					) : (
						<Button
							type="button"
							variant="featured"
							className="h-auto w-full gap-2.5 rounded-[9px] py-2.5 text-[13px] font-bold"
							onClick={() => void signInWithGoogle(returnTo)}
						>
							<GoogleMark />
							Continue with Google
						</Button>
					)
				) : null}

				{showOpenFallback ? (
					<Button
						asChild
						variant="featured"
						className="h-auto w-full rounded-[10px] py-2.75 text-[13.5px] font-bold"
					>
						<a href={OAUTH_CONSENT_OPEN_HREF}>Continue in LixRay</a>
					</Button>
				) : null}

				{details && !connected ? (
					<>
						<div
							title={`Requested OAuth scopes: ${details.scopes.join(" ") || "none"}`}
							className="flex flex-col gap-[11px] rounded-[11px] border border-border bg-bg-subtle px-[17px] py-[15px]"
							aria-label="Permissions"
						>
							<ScopeLine allowed>See your repositories and branches</ScopeLine>
							<ScopeLine allowed>
								Read and write files in repositories you open
							</ScopeLine>
							<ScopeLine>
								It can’t manage members or delete repositories
							</ScopeLine>
						</div>
						<div className="flex gap-2.5">
							<Button
								type="button"
								variant="outline"
								className="h-auto flex-1 rounded-[10px] py-2.75 text-[13.5px] font-semibold"
								disabled={submitting !== null}
								onClick={() => void decide("deny")}
							>
								{submitting === "deny" ? "Denying…" : "Deny"}
							</Button>
							<Button
								type="button"
								variant="featured"
								className="h-auto flex-[1.6] rounded-[10px] py-2.75 text-[13.5px] font-bold"
								disabled={submitting !== null}
								onClick={() => void decide("approve")}
							>
								{submitting === "approve" ? "Connecting…" : "Allow and connect"}
							</Button>
						</div>
					</>
				) : null}

				{error ? (
					<p className="m-0 w-full whitespace-pre-wrap rounded-[9px] border border-danger-subtle bg-danger-subtle px-3.5 py-3 text-left text-[12.5px] leading-[1.55] text-diff-removed">
						{error}
					</p>
				) : null}

				{details && !connected ? (
					<p className="m-0 text-center text-[11.5px] leading-normal text-fg-faint">
						You’ll be sent back to {displayOrigin(details.redirectUri)} to
						finish.
					</p>
				) : null}
			</div>
		</main>
	);
}

function ScopeLine({
	allowed = false,
	children,
}: {
	readonly allowed?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<span
			className={`flex items-start gap-2.5 text-[13px] leading-normal ${
				allowed ? "text-fg-muted" : "text-fg-subtle"
			}`}
		>
			{allowed ? (
				<Check
					aria-hidden="true"
					strokeWidth={2.4}
					className="mt-0.5 size-3.5 shrink-0 text-tag-green-fg"
				/>
			) : (
				<X
					aria-hidden="true"
					strokeWidth={2.4}
					className="mt-0.5 size-3.5 shrink-0 text-fg-subtle"
				/>
			)}
			{children}
		</span>
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

function displayHost(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return value;
	}
}

function displayOrigin(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return "the requesting app";
	}
}
