import { compatibility } from "@lix-js/sdk/compatibility";
export interface LixAccountProfile {
	id: string;
	kind: string;
	name: string;
	profileUri: string | null;
}

const TRUSTED_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";
const SESSION_ID_HEADER = "Lix-Session-Id";
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * Enrich the repository-local account created by an authenticated handshake.
 *
 * Lix's current server protocol creates the durable account row from the
 * trusted ID alone. LixRay owns the public profile, so it follows a successful
 * handshake with a trusted profile read and, when needed, an update in the
 * new session. The server's write dialect supports equality predicates but
 * does not support inequality, so compare the profile before updating it.
 */
export async function provisionAccountAfterHandshake(options: {
	lixId: string;
	protocolPath: string;
	response: Response;
	account?: LixAccountProfile;
	lixFetch: (request: Request) => Promise<Response>;
}): Promise<Response> {
	const basePath = `/lix/v1/${options.lixId}`;
	if (
		options.protocolPath.replace(/\/+$/, "") !== basePath ||
		!options.response.ok ||
		!options.account ||
		options.account.profileUri === null
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

	const url = new URL(`${basePath}/execute`, "https://lixray.internal");
	const account = options.account;
	const execute = (sql: string, values: string[]) =>
		options.lixFetch(
			new Request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Lix-Server-Protocol-Version": String(
						compatibility.serverProtocolVersion,
					),
					[SESSION_ID_HEADER]: sessionId,
					[IDEMPOTENCY_KEY_HEADER]: `account-profile-${crypto.randomUUID()}`,
					[TRUSTED_PRINCIPAL_HEADER]: account.id,
				},
				body: JSON.stringify({
					sql,
					params: values.map((value) => ({ kind: "text", value })),
				}),
			}),
		);
	const currentProfile = await execute(
		"SELECT name, kind, profile_uri FROM lix_account WHERE id = $1",
		[options.account.id],
	);
	if (!currentProfile.ok) {
		return new Response("Lix account provisioning failed\n", { status: 502 });
	}
	let result: { rows?: Array<Array<{ kind?: string; value?: unknown }>> };
	try {
		result = (await currentProfile.json()) as typeof result;
	} catch {
		return new Response("Lix account provisioning failed\n", { status: 502 });
	}
	const row = result?.rows?.[0];
	if (
		!Array.isArray(result?.rows) ||
		result.rows.length !== 1 ||
		!Array.isArray(row) ||
		row.length !== 3
	) {
		return new Response("Lix account provisioning failed\n", { status: 502 });
	}
	const desiredProfile = [
		options.account.name,
		options.account.kind,
		options.account.profileUri,
	];
	if (
		row.every(
			(cell, index) =>
				cell?.kind === "text" && cell.value === desiredProfile[index],
		)
	) {
		return options.response;
	}
	const provisioning = await execute(
		"UPDATE lix_account SET name = $2, kind = $3, profile_uri = $4 WHERE id = $1",
		[options.account.id, ...desiredProfile],
	);
	if (!provisioning.ok) {
		return new Response("Lix account provisioning failed\n", { status: 502 });
	}
	return options.response;
}
