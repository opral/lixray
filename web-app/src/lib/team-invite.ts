/**
 * Team invite links join the workspace's namespace (unlike lix share tokens,
 * which grant a single workspace). The token travels in the same `invite`
 * query parameter and is told apart by its `tm_` prefix.
 */
const PENDING_TEAM_INVITE_KEY = "lixray.team-invite.pending";

export function isTeamInviteToken(value: unknown): value is `tm_${string}` {
	return typeof value === "string" && /^tm_[A-Za-z0-9_-]{16,64}$/.test(value);
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
