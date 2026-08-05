/**
 * Team invite links join the workspace's namespace (unlike lix share tokens,
 * which grant a single workspace). The token travels in the same `invite`
 * query parameter and is told apart by its `tm_` prefix.
 */
const PENDING_TEAM_INVITE_KEY = "lixray.team-invite.pending";

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

/** Holds an invite across the sign-in redirect, same-tab session only. */
export function stageTeamInvite(token: string): void {
	window.sessionStorage.setItem(PENDING_TEAM_INVITE_KEY, token);
}

export function takeTeamInvite(): string | null {
	const token = window.sessionStorage.getItem(PENDING_TEAM_INVITE_KEY);
	window.sessionStorage.removeItem(PENDING_TEAM_INVITE_KEY);
	return isTeamInviteToken(token) ? token : null;
}
