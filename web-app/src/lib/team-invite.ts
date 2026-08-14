/**
 * Team invite links join the workspace's namespace (unlike lix share tokens,
 * which grant a single workspace). The token travels in the same `invite`
 * query parameter and is told apart by its `tm_` prefix.
 */
const PENDING_TEAM_INVITE_KEY = "lixray.team-invite.pending";

export interface PendingTeamInvite {
	readonly token: `tm_${string}`;
	readonly namespace: string;
	readonly workspaceSlug: string;
}

export function isTeamInviteToken(value: unknown): value is `tm_${string}` {
	return typeof value === "string" && /^tm_[A-Za-z0-9_-]{16,64}$/.test(value);
}

const TOKEN_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A client-side token in the server's format — for the demo deployment's
 * in-memory team, where no Supabase mints the real thing.
 */
export function randomTeamInviteToken(): `tm_${string}` {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	let token = "";
	for (const byte of bytes) token += TOKEN_ALPHABET[byte & 63];
	return `tm_${token}`;
}

/** Holds a route-bound invite across the sign-in redirect, same-tab only. */
export function stageTeamInvite(invite: PendingTeamInvite): void {
	window.sessionStorage.setItem(
		PENDING_TEAM_INVITE_KEY,
		JSON.stringify(invite),
	);
}

export function peekTeamInvite(): PendingTeamInvite | null {
	if (typeof window === "undefined") return null;
	const serialized = window.sessionStorage.getItem(PENDING_TEAM_INVITE_KEY);
	if (!serialized) return null;
	try {
		const invite = JSON.parse(serialized) as Partial<PendingTeamInvite>;
		return isTeamInviteToken(invite.token) &&
			typeof invite.namespace === "string" &&
			invite.namespace.length > 0 &&
			typeof invite.workspaceSlug === "string" &&
			invite.workspaceSlug.length > 0
			? {
					token: invite.token,
					namespace: invite.namespace,
					workspaceSlug: invite.workspaceSlug,
				}
			: null;
	} catch {
		return null;
	}
}

export function takeTeamInvite(): PendingTeamInvite | null {
	if (typeof window === "undefined") return null;
	const invite = peekTeamInvite();
	window.sessionStorage.removeItem(PENDING_TEAM_INVITE_KEY);
	return invite;
}

export function stagedTeamInviteForRoute(
	invite: PendingTeamInvite | null,
	namespace: string,
	workspaceSlug: string,
): `tm_${string}` | null {
	return invite?.namespace === namespace &&
		invite.workspaceSlug === workspaceSlug
		? invite.token
		: null;
}
