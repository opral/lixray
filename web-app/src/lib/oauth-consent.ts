export const OAUTH_CONSENT_FALLBACK_MS = 2000;
export const OAUTH_CONSENT_OPEN_HREF = "/open";
export const OAUTH_CONSENT_RESOLVED_EVENT = "lixray_oauth_consent_resolved";

export type OAuthConsentDecision = "approve" | "deny";

export type OAuthConsentDecisionResult = {
	error?: { message?: string } | null;
	data?: { redirect_url?: string } | null;
};

export type OAuthConsentAuthorizer = {
	approveAuthorization: (
		authorizationId: string,
		options: { skipBrowserRedirect: true },
	) => Promise<OAuthConsentDecisionResult>;
	denyAuthorization: (
		authorizationId: string,
		options: { skipBrowserRedirect: true },
	) => Promise<OAuthConsentDecisionResult>;
};

export type OAuthConsentResolvedProperties = {
	decision: OAuthConsentDecision;
	client_name: string;
	redirect_host: string;
};

/** Host of an OAuth redirect target — never the full URL. */
export function redirectHostFromUrl(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return "";
	}
}

export function oauthConsentResolvedProperties(input: {
	decision: OAuthConsentDecision;
	clientName: string;
	redirectUrl: string;
}): OAuthConsentResolvedProperties {
	return {
		decision: input.decision,
		client_name: input.clientName,
		redirect_host: redirectHostFromUrl(input.redirectUrl),
	};
}

/**
 * Completes an OAuth consent decision: grant/deny with skipBrowserRedirect,
 * emit `lixray_oauth_consent_resolved`, then navigate to the client
 * `redirect_url`. Approve also schedules an in-tab /open fallback for when
 * the client hop leaves the document on lixray.com.
 */
export async function resolveOAuthConsentDecision(
	input: {
		decision: OAuthConsentDecision;
		authorizationId: string;
		clientName: string;
		oauth: OAuthConsentAuthorizer;
	},
	deps: {
		captureImmediately: (
			event: string,
			properties: OAuthConsentResolvedProperties,
		) => void | Promise<void>;
		navigate: (url: string) => void;
		scheduleFallback?: (callback: () => void, delayMs: number) => void;
		onShowOpenFallback?: () => void;
	},
): Promise<{ ok: true; redirectUrl: string } | { ok: false; error: string }> {
	const decide =
		input.decision === "approve"
			? input.oauth.approveAuthorization
			: input.oauth.denyAuthorization;
	const result = await decide(input.authorizationId, {
		skipBrowserRedirect: true,
	});
	if (result.error || !result.data?.redirect_url) {
		return {
			ok: false,
			error: result.error?.message ?? "Unable to complete authorization.",
		};
	}

	const redirectUrl = result.data.redirect_url;
	await deps.captureImmediately(
		OAUTH_CONSENT_RESOLVED_EVENT,
		oauthConsentResolvedProperties({
			decision: input.decision,
			clientName: input.clientName,
			redirectUrl,
		}),
	);

	deps.navigate(redirectUrl);

	if (input.decision === "approve") {
		const schedule =
			deps.scheduleFallback ??
			((callback, delayMs) => {
				setTimeout(callback, delayMs);
			});
		schedule(() => {
			deps.onShowOpenFallback?.();
		}, OAUTH_CONSENT_FALLBACK_MS);
	}

	return { ok: true, redirectUrl };
}
