import type { LixAccountProfile } from "../mcp/lix-account-provisioning.ts";

type Result =
	| { ok: true; account: LixAccountProfile }
	| { ok: false; response: Response };

/** Authorize each SDK request against the current token and membership state. */
export async function authorizeApiToken(
	token: string,
	lixId: string | null,
	env: { SUPABASE_URL?: string; SUPABASE_PUBLISHABLE_KEY?: string },
	fetchImpl: typeof fetch = fetch,
): Promise<Result> {
	const reject = (status: number, message: string): Result => ({
		ok: false,
		response: new Response(`${message}\n`, {
			status,
			headers: {
				"Cache-Control": "no-store",
				...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
			},
		}),
	});
	if (!/^lixray_pat_[0-9a-f]{64}$/.test(token)) {
		return reject(401, "Invalid or expired API token");
	}
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return reject(503, "API token authorization is unavailable");
	}
	try {
		const response = await fetchImpl(
			new URL("/rest/v1/rpc/authorize_api_token", env.SUPABASE_URL),
			{
				method: "POST",
				headers: {
					apikey: env.SUPABASE_PUBLISHABLE_KEY,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ p_token: token, p_lix_id: lixId }),
				cache: "no-store",
			},
		);
		if (!response.ok)
			return reject(503, "API token authorization is unavailable");
		const rows: unknown = await response.json();
		if (!Array.isArray(rows))
			return reject(503, "API token authorization is unavailable");
		if (rows.length === 0) return reject(401, "Invalid or expired API token");
		const row = rows[0] as Record<string, unknown> | null;
		if (
			rows.length !== 1 ||
			!row ||
			typeof row.account_id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				row.account_id,
			) ||
			typeof row.kind !== "string" ||
			!row.kind.trim() ||
			typeof row.name !== "string" ||
			!row.name.trim() ||
			(row.profile_uri !== null && typeof row.profile_uri !== "string") ||
			typeof row.allowed !== "boolean"
		)
			return reject(503, "API token authorization is unavailable");
		if (!row.allowed) return reject(403, "Lix access denied");
		return {
			ok: true,
			account: {
				id: row.account_id,
				kind: row.kind,
				name: row.name,
				profileUri: row.profile_uri,
			},
		};
	} catch {
		return reject(503, "API token authorization is unavailable");
	}
}
