export interface LixAccountProfile {
	id: string;
	kind: string;
	name: string;
	profileUri: string;
}

const TRUSTED_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";
const SESSION_ID_HEADER = "Lix-Session-Id";
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * Enrich the repository-local account created by an authenticated handshake.
 *
 * Lix's current server protocol creates the durable account row from the
 * trusted ID alone. LixRay owns the public profile, so it follows a successful
 * handshake with one trusted, conditional update in the new session.
 */
export async function provisionAccountAfterHandshake(options: {
	protocolPath: string;
	response: Response;
	account?: LixAccountProfile;
	lixFetch: (request: Request) => Promise<Response>;
}): Promise<Response> {
	if (
		options.protocolPath !== "/lix/v1/" ||
		!options.response.ok ||
		!options.account
	) {
		return options.response;
	}

	let handshake: unknown;
	try {
		handshake = await options.response.clone().json();
	} catch {
		return options.response;
	}
	if (!handshake || typeof handshake !== "object") return options.response;
	const sessionId = (handshake as Record<string, unknown>).sessionId;
	const activeAccountId = (handshake as Record<string, unknown>)
		.activeAccountId;
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		activeAccountId !== options.account.id
	) {
		return new Response("Lix account provisioning failed\n", { status: 502 });
	}

	const url = new URL("https://lixray.internal/lix/v1/execute");
	const provisioning = await options.lixFetch(
		new Request(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[SESSION_ID_HEADER]: sessionId,
				[IDEMPOTENCY_KEY_HEADER]: `account-profile-${crypto.randomUUID()}`,
				[TRUSTED_PRINCIPAL_HEADER]: options.account.id,
			},
			body: JSON.stringify({
				sql: "UPDATE lix_account SET name = $2, kind = $3, profile_uri = $4 WHERE id = $1 AND (name <> $2 OR kind <> $3 OR profile_uri IS NULL OR profile_uri <> $4)",
				params: [
					{ kind: "text", value: options.account.id },
					{ kind: "text", value: options.account.name },
					{ kind: "text", value: options.account.kind },
					{ kind: "text", value: options.account.profileUri },
				],
			}),
		}),
	);
	if (!provisioning.ok) {
		return new Response("Lix account provisioning failed\n", { status: 502 });
	}
	return options.response;
}
