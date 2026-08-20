import assert from "node:assert/strict";
import test from "node:test";
import {
	OAUTH_CONSENT_FALLBACK_MS,
	OAUTH_CONSENT_OPEN_HREF,
	OAUTH_CONSENT_RESOLVED_EVENT,
	oauthConsentResolvedProperties,
	redirectHostFromUrl,
	resolveOAuthConsentDecision,
	type OAuthConsentAuthorizer,
	type OAuthConsentDecisionResult,
} from "./oauth-consent.ts";

const CLIENT_REDIRECT_URL =
	"https://chatgpt.com/connector/oauth/callback?code=auth-code&state=xyz";
const LOOPBACK_REDIRECT_URL = "http://127.0.0.1:8765/callback?code=loopback";
const CUSTOM_SCHEME_REDIRECT_URL =
	"cursor://anysphere.cursor-mcp/oauth/callback?code=custom";

function authorizer(
	result: OAuthConsentDecisionResult,
	calls: Array<{ method: "approve" | "deny"; id: string }>,
): OAuthConsentAuthorizer {
	return {
		approveAuthorization: async (authorizationId, options) => {
			assert.deepEqual(options, { skipBrowserRedirect: true });
			calls.push({ method: "approve", id: authorizationId });
			return result;
		},
		denyAuthorization: async (authorizationId, options) => {
			assert.deepEqual(options, { skipBrowserRedirect: true });
			calls.push({ method: "deny", id: authorizationId });
			return result;
		},
	};
}

void test("redirectHostFromUrl is the host, never the full URL", () => {
	assert.equal(redirectHostFromUrl(CLIENT_REDIRECT_URL), "chatgpt.com");
	assert.equal(redirectHostFromUrl(LOOPBACK_REDIRECT_URL), "127.0.0.1:8765");
	assert.equal(
		redirectHostFromUrl(CUSTOM_SCHEME_REDIRECT_URL),
		"anysphere.cursor-mcp",
	);
	assert.equal(redirectHostFromUrl("not a url"), "");
	assert.doesNotMatch(redirectHostFromUrl(CLIENT_REDIRECT_URL), /code=/);
	assert.doesNotMatch(redirectHostFromUrl(CLIENT_REDIRECT_URL), /https:/);
});

void test("resolved event properties are decision, client_name, redirect_host", () => {
	assert.deepEqual(
		oauthConsentResolvedProperties({
			decision: "approve",
			clientName: "ChatGPT",
			redirectUrl: CLIENT_REDIRECT_URL,
		}),
		{
			decision: "approve",
			client_name: "ChatGPT",
			redirect_host: "chatgpt.com",
		},
	);
	assert.equal(OAUTH_CONSENT_OPEN_HREF, "/open");
	assert.equal(OAUTH_CONSENT_RESOLVED_EVENT, "lixray_oauth_consent_resolved");
	assert.equal(OAUTH_CONSENT_FALLBACK_MS, 2000);
});

void test("approve navigates to the client redirect_url and offers /open if still here", async () => {
	const oauthCalls: Array<{ method: "approve" | "deny"; id: string }> = [];
	const navigations: Array<string> = [];
	const events: Array<{ event: string; properties: unknown }> = [];
	const scheduled: Array<{ delayMs: number; callback: () => void }> = [];
	let showOpenFallback = false;

	const outcome = await resolveOAuthConsentDecision(
		{
			decision: "approve",
			authorizationId: "auth-1",
			clientName: "ChatGPT",
			oauth: authorizer(
				{ data: { redirect_url: CLIENT_REDIRECT_URL } },
				oauthCalls,
			),
		},
		{
			captureImmediately: (event, properties) => {
				events.push({ event, properties });
			},
			navigate: (url) => {
				navigations.push(url);
			},
			scheduleFallback: (callback, delayMs) => {
				scheduled.push({ delayMs, callback });
			},
			onShowOpenFallback: () => {
				showOpenFallback = true;
			},
		},
	);

	assert.deepEqual(outcome, { ok: true, redirectUrl: CLIENT_REDIRECT_URL });
	assert.deepEqual(oauthCalls, [{ method: "approve", id: "auth-1" }]);
	assert.deepEqual(navigations, [CLIENT_REDIRECT_URL]);
	assert.deepEqual(events, [
		{
			event: "lixray_oauth_consent_resolved",
			properties: {
				decision: "approve",
				client_name: "ChatGPT",
				redirect_host: "chatgpt.com",
			},
		},
	]);
	assert.equal(scheduled.length, 1);
	assert.equal(scheduled[0]?.delayMs, 2000);
	assert.equal(showOpenFallback, false);

	scheduled[0]?.callback();
	assert.equal(showOpenFallback, true);
	assert.equal(OAUTH_CONSENT_OPEN_HREF, "/open");
});

void test("approve still delivers a loopback or custom-scheme redirect_url", async () => {
	for (const redirectUrl of [
		LOOPBACK_REDIRECT_URL,
		CUSTOM_SCHEME_REDIRECT_URL,
	]) {
		const navigations: Array<string> = [];
		const outcome = await resolveOAuthConsentDecision(
			{
				decision: "approve",
				authorizationId: "auth-loop",
				clientName: "Codex",
				oauth: authorizer({ data: { redirect_url: redirectUrl } }, []),
			},
			{
				captureImmediately: () => undefined,
				navigate: (url) => {
					navigations.push(url);
				},
				scheduleFallback: () => undefined,
			},
		);
		assert.deepEqual(outcome, { ok: true, redirectUrl });
		assert.deepEqual(navigations, [redirectUrl]);
	}
});

void test("deny navigates to the client error redirect and does not offer /open", async () => {
	const oauthCalls: Array<{ method: "approve" | "deny"; id: string }> = [];
	const navigations: Array<string> = [];
	const events: Array<{ event: string; properties: unknown }> = [];
	let scheduled = 0;
	let showOpenFallback = false;

	const outcome = await resolveOAuthConsentDecision(
		{
			decision: "deny",
			authorizationId: "auth-2",
			clientName: "Claude",
			oauth: authorizer(
				{
					data: {
						redirect_url:
							"https://claude.ai/oauth/callback?error=access_denied",
					},
				},
				oauthCalls,
			),
		},
		{
			captureImmediately: (event, properties) => {
				events.push({ event, properties });
			},
			navigate: (url) => {
				navigations.push(url);
			},
			scheduleFallback: () => {
				scheduled += 1;
			},
			onShowOpenFallback: () => {
				showOpenFallback = true;
			},
		},
	);

	assert.deepEqual(outcome, {
		ok: true,
		redirectUrl: "https://claude.ai/oauth/callback?error=access_denied",
	});
	assert.deepEqual(oauthCalls, [{ method: "deny", id: "auth-2" }]);
	assert.deepEqual(navigations, [
		"https://claude.ai/oauth/callback?error=access_denied",
	]);
	assert.deepEqual(events, [
		{
			event: "lixray_oauth_consent_resolved",
			properties: {
				decision: "deny",
				client_name: "Claude",
				redirect_host: "claude.ai",
			},
		},
	]);
	assert.equal(scheduled, 0);
	assert.equal(showOpenFallback, false);
});

void test("authorization errors do not navigate or emit the resolved event", async () => {
	const navigations: Array<string> = [];
	const events: Array<{ event: string; properties: unknown }> = [];
	const outcome = await resolveOAuthConsentDecision(
		{
			decision: "approve",
			authorizationId: "auth-3",
			clientName: "ChatGPT",
			oauth: authorizer({ error: { message: "already used" } }, []),
		},
		{
			captureImmediately: (event, properties) => {
				events.push({ event, properties });
			},
			navigate: (url) => {
				navigations.push(url);
			},
			scheduleFallback: () => {
				throw new Error("should not schedule");
			},
		},
	);

	assert.deepEqual(outcome, { ok: false, error: "already used" });
	assert.deepEqual(navigations, []);
	assert.deepEqual(events, []);
});
