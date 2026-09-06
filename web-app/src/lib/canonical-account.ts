import { decodeJwt } from "jose";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Reads the canonical LixRay account selected by the Supabase access-token
 * hook. The browser already received this token as an authenticated Supabase
 * session; authorization remains server-side and never trusts this decode.
 */
export function canonicalAccountIdFromAccessToken(
	accessToken: string | null | undefined,
): string | null {
	if (!accessToken) return null;
	try {
		const accountId = decodeJwt(accessToken).account_id;
		return typeof accountId === "string" && UUID_PATTERN.test(accountId)
			? accountId.toLowerCase()
			: null;
	} catch {
		return null;
	}
}
