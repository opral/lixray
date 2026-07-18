import { isWorkspaceShareToken } from "./workspace-share-capability";

const PREVIEW_SHARE_PATH = "/_preview/workspace-share-capabilities";
const PREVIEW_SESSION_PATH = "/_preview/demo-session";

export type PreviewSessionMode = "owner" | "recipient";

export interface PreviewDemoSession {
	readonly signedIn: boolean;
	readonly workspaceIds: ReadonlyArray<string>;
}

export interface PreviewWorkspaceShareToken {
	readonly workspaceId: string;
	readonly sharedByName: string | null;
	readonly grantsEdit: boolean;
}

/**
 * The PR-preview runtime has no Supabase binding. These calls deliberately
 * target its isolated R2-backed capability simulator instead, so the preview
 * can demonstrate the link funnel without pretending to exercise production
 * RLS or OAuth.
 */
export async function createPreviewWorkspaceShareToken(
	workspaceId: string,
): Promise<string> {
	const response = await fetch(PREVIEW_SHARE_PATH, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspaceId }),
	});
	if (!response.ok) throw await previewShareError(response);
	const payload: unknown = await response.json();
	const token =
		payload && typeof payload === "object" && "token" in payload
			? payload.token
			: undefined;
	if (!isWorkspaceShareToken(token)) {
		throw new Error("The preview share service returned an invalid link.");
	}
	return token;
}

export async function resolvePreviewWorkspaceShareToken(
	token: string,
): Promise<PreviewWorkspaceShareToken | null> {
	const response = await fetch(
		`${PREVIEW_SHARE_PATH}/${encodeURIComponent(token)}`,
	);
	if (response.status === 404) return null;
	if (!response.ok) throw await previewShareError(response);
	return previewShareToken(await response.json());
}

export async function acceptPreviewWorkspaceShareToken(
	token: string,
): Promise<PreviewWorkspaceShareToken | null> {
	const response = await fetch(
		`${PREVIEW_SHARE_PATH}/${encodeURIComponent(token)}/accept`,
		{ method: "POST" },
	);
	if (response.status === 404) return null;
	if (!response.ok) throw await previewShareError(response);
	return previewShareToken(await response.json());
}

/** Read the HttpOnly, server-verifiable preview test-account session. */
export async function readPreviewDemoSession(): Promise<PreviewDemoSession> {
	const response = await fetch(PREVIEW_SESSION_PATH, {
		credentials: "same-origin",
	});
	if (!response.ok) throw await previewShareError(response);
	return previewDemoSession(await response.json());
}

/**
 * Creates an isolated preview test-account session. Owners begin with the demo
 * workspaces; recipients gain a workspace only after accepting their link.
 */
export async function startPreviewDemoSession(
	mode: PreviewSessionMode,
): Promise<PreviewDemoSession> {
	const response = await fetch(PREVIEW_SESSION_PATH, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode }),
	});
	if (!response.ok) throw await previewShareError(response);
	return previewDemoSession(await response.json());
}

export async function endPreviewDemoSession(): Promise<void> {
	const response = await fetch(PREVIEW_SESSION_PATH, {
		method: "DELETE",
		credentials: "same-origin",
	});
	if (!response.ok) throw await previewShareError(response);
}

function previewShareToken(payload: unknown): PreviewWorkspaceShareToken {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("The preview share service returned an invalid response.");
	}
	const candidate = payload as Partial<PreviewWorkspaceShareToken>;
	if (
		typeof candidate.workspaceId !== "string" ||
		candidate.workspaceId.length === 0 ||
		(candidate.sharedByName !== null &&
			typeof candidate.sharedByName !== "string") ||
		candidate.grantsEdit !== true
	) {
		throw new Error("The preview share service returned an invalid response.");
	}
	return {
		workspaceId: candidate.workspaceId,
		sharedByName: candidate.sharedByName ?? null,
		grantsEdit: true,
	};
}

function previewDemoSession(payload: unknown): PreviewDemoSession {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error(
			"The preview sign-in service returned an invalid response.",
		);
	}
	const candidate = payload as Partial<PreviewDemoSession>;
	if (
		typeof candidate.signedIn !== "boolean" ||
		!Array.isArray(candidate.workspaceIds) ||
		candidate.workspaceIds.some(
			(workspaceId) =>
				typeof workspaceId !== "string" || workspaceId.length === 0,
		)
	) {
		throw new Error(
			"The preview sign-in service returned an invalid response.",
		);
	}
	return {
		signedIn: candidate.signedIn,
		workspaceIds: [...new Set(candidate.workspaceIds)],
	};
}

async function previewShareError(response: Response): Promise<Error> {
	try {
		const payload: unknown = await response.json();
		if (
			payload &&
			typeof payload === "object" &&
			"error" in payload &&
			typeof payload.error === "string"
		) {
			return new Error(payload.error);
		}
	} catch {
		// Fall back to a status-specific message below.
	}
	return new Error(`Preview share request failed (${response.status}).`);
}
