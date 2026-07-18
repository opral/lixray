/**
 * A capability URL is intentionally short-lived in the browser: once its
 * grant has been resolved, the URL is replaced with the canonical resource
 * URL and this session record carries the capability through authentication.
 */
const PENDING_SHARE_CAPABILITY_KEY = "lixray.workspace-share.pending";
const SHARE_JOIN_INTENT_KEY = "lixray.workspace-share.join-intent";
const SHARE_JOIN_ERROR_KEY = "lixray.workspace-share.join-error";
const JOINED_WORKSPACE_KEY_PREFIX = "lixray.workspace-share.joined:";

export interface PendingWorkspaceShareCapability {
	readonly token: string;
	readonly workspaceId: string;
	readonly sharerName: string | null;
}

export function isWorkspaceShareToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function stageWorkspaceShareCapability(
	capability: PendingWorkspaceShareCapability,
): void {
	window.sessionStorage.setItem(
		PENDING_SHARE_CAPABILITY_KEY,
		JSON.stringify(capability),
	);
}

export function peekWorkspaceShareCapability(): PendingWorkspaceShareCapability | null {
	const encoded = window.sessionStorage.getItem(PENDING_SHARE_CAPABILITY_KEY);
	if (!encoded) return null;
	try {
		const parsed: unknown = JSON.parse(encoded);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const candidate = parsed as Partial<PendingWorkspaceShareCapability>;
		if (
			!isWorkspaceShareToken(candidate.token) ||
			typeof candidate.workspaceId !== "string" ||
			candidate.workspaceId.length === 0 ||
			(candidate.sharerName !== null &&
				typeof candidate.sharerName !== "string")
		) {
			return null;
		}
		return {
			token: candidate.token,
			workspaceId: candidate.workspaceId,
			sharerName: candidate.sharerName ?? null,
		};
	} catch {
		return null;
	}
}

export function takeWorkspaceShareCapability(): PendingWorkspaceShareCapability | null {
	const capability = peekWorkspaceShareCapability();
	window.sessionStorage.removeItem(PENDING_SHARE_CAPABILITY_KEY);
	return capability;
}

export function clearWorkspaceShareCapability(): void {
	window.sessionStorage.removeItem(PENDING_SHARE_CAPABILITY_KEY);
}

/** A link view remains read-only until the visitor explicitly asks to join. */
export function requestWorkspaceShareJoin(workspaceId: string): void {
	window.sessionStorage.setItem(SHARE_JOIN_INTENT_KEY, workspaceId);
}

export function peekWorkspaceShareJoinIntent(): string | null {
	return window.sessionStorage.getItem(SHARE_JOIN_INTENT_KEY) || null;
}

export function takeWorkspaceShareJoinIntent(): string | null {
	const workspaceId = window.sessionStorage.getItem(SHARE_JOIN_INTENT_KEY);
	window.sessionStorage.removeItem(SHARE_JOIN_INTENT_KEY);
	return workspaceId || null;
}

export function stageWorkspaceShareJoinError(message: string): void {
	window.sessionStorage.setItem(SHARE_JOIN_ERROR_KEY, message);
}

export function takeWorkspaceShareJoinError(): string | null {
	const message = window.sessionStorage.getItem(SHARE_JOIN_ERROR_KEY);
	window.sessionStorage.removeItem(SHARE_JOIN_ERROR_KEY);
	return message || null;
}

export function markWorkspaceShareJoined(workspaceId: string): void {
	window.sessionStorage.setItem(
		`${JOINED_WORKSPACE_KEY_PREFIX}${workspaceId}`,
		"1",
	);
}

export function takeWorkspaceShareJoined(workspaceId: string): boolean {
	const key = `${JOINED_WORKSPACE_KEY_PREFIX}${workspaceId}`;
	const joined = window.sessionStorage.getItem(key) === "1";
	window.sessionStorage.removeItem(key);
	return joined;
}
