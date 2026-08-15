/**
 * A capability URL is intentionally short-lived in the browser: once its
 * grant has been resolved, the URL is replaced with the canonical resource
 * URL and this session record carries the capability through authentication.
 */
const PENDING_SHARE_CAPABILITY_KEY = "lixray.repository-share.pending";
const SHARE_JOIN_INTENT_KEY = "lixray.repository-share.join-intent";
const SHARE_JOIN_ERROR_KEY = "lixray.repository-share.join-error";
const JOINED_REPOSITORY_KEY_PREFIX = "lixray.repository-share.joined:";

export interface PendingRepositoryShareCapability {
	readonly token: string;
	readonly repositoryId: string;
	readonly sharerName: string | null;
}

export function isRepositoryShareToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{21,256}$/.test(value);
}

export function stageRepositoryShareCapability(
	capability: PendingRepositoryShareCapability,
): void {
	window.sessionStorage.setItem(
		PENDING_SHARE_CAPABILITY_KEY,
		JSON.stringify(capability),
	);
}

export function peekRepositoryShareCapability(): PendingRepositoryShareCapability | null {
	const encoded = window.sessionStorage.getItem(PENDING_SHARE_CAPABILITY_KEY);
	if (!encoded) return null;
	try {
		const parsed: unknown = JSON.parse(encoded);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const candidate = parsed as Partial<PendingRepositoryShareCapability>;
		if (
			!isRepositoryShareToken(candidate.token) ||
			typeof candidate.repositoryId !== "string" ||
			candidate.repositoryId.length === 0 ||
			(candidate.sharerName !== null &&
				typeof candidate.sharerName !== "string")
		) {
			return null;
		}
		return {
			token: candidate.token,
			repositoryId: candidate.repositoryId,
			sharerName: candidate.sharerName ?? null,
		};
	} catch {
		return null;
	}
}

export function takeRepositoryShareCapability(): PendingRepositoryShareCapability | null {
	const capability = peekRepositoryShareCapability();
	window.sessionStorage.removeItem(PENDING_SHARE_CAPABILITY_KEY);
	return capability;
}

export function clearRepositoryShareCapability(): void {
	window.sessionStorage.removeItem(PENDING_SHARE_CAPABILITY_KEY);
}

/** A link view remains read-only until the visitor explicitly asks to join. */
export function requestRepositoryShareJoin(repositoryId: string): void {
	window.sessionStorage.setItem(SHARE_JOIN_INTENT_KEY, repositoryId);
}

export function peekRepositoryShareJoinIntent(): string | null {
	if (typeof window === "undefined") return null;
	return window.sessionStorage.getItem(SHARE_JOIN_INTENT_KEY) || null;
}

export function takeRepositoryShareJoinIntent(): string | null {
	const repositoryId = window.sessionStorage.getItem(SHARE_JOIN_INTENT_KEY);
	window.sessionStorage.removeItem(SHARE_JOIN_INTENT_KEY);
	return repositoryId || null;
}

export function stageRepositoryShareJoinError(message: string): void {
	window.sessionStorage.setItem(SHARE_JOIN_ERROR_KEY, message);
}

export function takeRepositoryShareJoinError(): string | null {
	const message = window.sessionStorage.getItem(SHARE_JOIN_ERROR_KEY);
	window.sessionStorage.removeItem(SHARE_JOIN_ERROR_KEY);
	return message || null;
}

export function markRepositoryShareJoined(repositoryId: string): void {
	window.sessionStorage.setItem(
		`${JOINED_REPOSITORY_KEY_PREFIX}${repositoryId}`,
		"1",
	);
}

export function takeRepositoryShareJoined(repositoryId: string): boolean {
	const key = `${JOINED_REPOSITORY_KEY_PREFIX}${repositoryId}`;
	const joined = window.sessionStorage.getItem(key) === "1";
	window.sessionStorage.removeItem(key);
	return joined;
}
