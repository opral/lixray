import type { Session } from "@supabase/supabase-js";

export const SIGNUP_TELEMETRY_PATH = "/api/telemetry/signup";
const SIGNUP_TELEMETRY_ATTEMPTS = 2;

export type SignupSurface = "web" | "mcp";
export type SignupSource = "direct" | "oauth" | "other";

export interface SignupTelemetryContext {
	surface: SignupSurface;
	source: SignupSource;
}

export function signupTelemetryContext(
	returnTo: string,
): SignupTelemetryContext {
	const pathname = safeReturnToPathname(returnTo);
	return {
		surface: pathname === "/oauth/consent" ? "mcp" : "web",
		source:
			pathname === "/open"
				? "direct"
				: pathname === "/oauth/consent"
					? "oauth"
					: "other",
	};
}

export async function reportUserSignedUp(
	session: Pick<Session, "access_token">,
	returnTo: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const request: RequestInit = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(signupTelemetryContext(returnTo)),
	};
	let lastFailure: unknown;
	for (let attempt = 0; attempt < SIGNUP_TELEMETRY_ATTEMPTS; attempt++) {
		try {
			const response = await fetchImpl(SIGNUP_TELEMETRY_PATH, request);
			if (response.ok) return;
			lastFailure = new Error(`Signup telemetry failed (${response.status})`);
			if (response.status < 500) break;
		} catch (error: unknown) {
			lastFailure = error;
		}
	}
	throw lastFailure instanceof Error
		? lastFailure
		: new Error("Signup telemetry failed");
}

function safeReturnToPathname(returnTo: string): string {
	try {
		const pathname = new URL(returnTo, "https://lixray.invalid").pathname;
		return pathname.startsWith("/") ? pathname : "/";
	} catch {
		return "/";
	}
}
