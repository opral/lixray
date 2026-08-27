import { PRODUCT_EVENTS, type ProductEvent } from "./telemetry-events.ts";

export const OAUTH_CONSENT_FALLBACK_MS = 2000;
export const OAUTH_CONSENT_OPEN_HREF = "/open";
export const OAUTH_CONSENT_RESOLVED_EVENT = PRODUCT_EVENTS.oauthConsentResolved;

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

export type OAuthConsentHandoff = "keep-tab" | "leave-tab";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** Host of an OAuth redirect target — never the full URL. */
export function redirectHostFromUrl(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return "";
	}
}

/**
 * Loopback HTTP(S) and non-http(s) schemes cannot take the current tab:
 * assign() unloads lixray.com and kills the /open fallback timer.
 */
export function keepsLixrayDocument(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return true;
		}
		const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return LOOPBACK_HOSTNAMES.has(hostname);
	} catch {
		return value.length > 0 && !/^https?:/i.test(value);
	}
}

export function oauthConsentHandoff(redirectUrl: string): OAuthConsentHandoff {
	return keepsLixrayDocument(redirectUrl) ? "keep-tab" : "leave-tab";
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
 * emit `oauth_consent_resolved`, then deliver the client
 * `redirect_url`. HTTPS approve assigns this tab and waits ~2s before
 * offering /open. Loopback and custom-scheme approve paint /open first,
 * then hop in another browsing context so this tab survives.
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
			event: ProductEvent,
			properties: OAuthConsentResolvedProperties,
		) => void | Promise<void>;
		navigate: (url: string) => void;
		openClientHop?: (url: string) => void;
		scheduleFallback?: (callback: () => void, delayMs: number) => void;
		onShowOpenFallback?: () => void;
	},
): Promise<
	| { ok: true; redirectUrl: string; handoff: OAuthConsentHandoff | "deny" }
	| { ok: false; error: string }
> {
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

	if (input.decision === "deny") {
		deps.navigate(redirectUrl);
		return { ok: true, redirectUrl, handoff: "deny" };
	}

	const handoff = oauthConsentHandoff(redirectUrl);
	if (handoff === "keep-tab") {
		deps.onShowOpenFallback?.();
		const openHop =
			deps.openClientHop ??
			((url) => {
				window.open(url, "_blank", "noopener,noreferrer");
			});
		openHop(redirectUrl);
		return { ok: true, redirectUrl, handoff };
	}

	deps.navigate(redirectUrl);
	const schedule =
		deps.scheduleFallback ??
		((callback, delayMs) => {
			setTimeout(callback, delayMs);
		});
	schedule(() => {
		deps.onShowOpenFallback?.();
	}, OAUTH_CONSENT_FALLBACK_MS);
	return { ok: true, redirectUrl, handoff };
}
