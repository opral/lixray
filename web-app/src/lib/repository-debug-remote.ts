import type { Lix } from "@lix-js/sdk";

export type RepositoryRemoteSnapshotFailureStage =
	| "request_headers"
	| "request"
	| "http_response"
	| "response_body";

export class RepositoryRemoteSnapshotError extends Error {
	readonly failureStage: RepositoryRemoteSnapshotFailureStage;
	readonly status?: number;
	readonly code: string;
	readonly requestId?: string;

	constructor(
		message: string,
		options: {
			failureStage: RepositoryRemoteSnapshotFailureStage;
			status?: number;
			requestId?: string;
			cause?: unknown;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "RepositoryRemoteSnapshotError";
		this.failureStage = options.failureStage;
		this.status = options.status;
		this.code =
			options.failureStage === "http_response" && options.status !== undefined
				? `HTTP_${options.status}`
				: `REMOTE_SNAPSHOT_${options.failureStage.toUpperCase()}`;
		this.requestId = options.requestId;
	}
}

export interface FetchRepositoryRemoteSnapshotOptions {
	/** The canonical `/lix/v1/{id}/snapshot` application route. */
	url: string | URL;
	headers?:
		| HeadersInit
		| (() => HeadersInit | Promise<HeadersInit>);
	/** Supply the app's authenticated, telemetry-aware fetch implementation. */
	fetch: typeof globalThis.fetch;
	signal?: AbortSignal;
}

/**
 * Fetches a repository-wide snapshot without opening a protocol client.
 * Snapshot export is independent of the protocol handshake and SQL branch.
 */
export async function fetchRepositoryRemoteSnapshot(
	options: FetchRepositoryRemoteSnapshotOptions,
): Promise<Blob> {
	let headers: Headers;
	try {
		const suppliedHeaders =
			typeof options.headers === "function"
				? await options.headers()
				: options.headers;
		headers = new Headers(suppliedHeaders);
		if (!headers.has("accept"))
			headers.set("accept", "application/vnd.lix.snapshot");
	} catch (cause) {
		throw new RepositoryRemoteSnapshotError(
			"Unable to prepare the remote Lix snapshot request",
			{ failureStage: "request_headers", cause },
		);
	}

	let response: Response;
	try {
		response = await options.fetch(options.url, {
			method: "GET",
			headers,
			signal: options.signal,
		});
	} catch (cause) {
		throw new RepositoryRemoteSnapshotError(
			"The remote Lix snapshot request failed",
			{ failureStage: "request", cause },
		);
	}

	const requestId = safeRequestId(response.headers.get("x-request-id"));
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel().catch(() => undefined);
		throw new RepositoryRemoteSnapshotError(
			`Remote Lix snapshot request failed with status ${status}`,
			{ failureStage: "http_response", status, requestId },
		);
	}

	try {
		return await response.blob();
	} catch (cause) {
		throw new RepositoryRemoteSnapshotError(
			"The remote Lix snapshot response could not be read",
			{ failureStage: "response_body", requestId, cause },
		);
	}
}

function safeRequestId(value: string | null): string | undefined {
	return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

/** A diagnostic handle can be reopened after a failed handshake or export. */
export function createRepositoryDebugRemote(
	open: () => Promise<Lix>,
	activeBranchId: () => string,
) {
	let current: Promise<Lix> | null = null;
	let closed = false;

	const acquire = (): Promise<Lix> => {
		if (closed) return Promise.reject(new Error("Debug session is closed"));
		if (current) return current;
		const opening = open();
		current = opening;
		void opening.catch(() => {
			if (current === opening) current = null;
		});
		return opening;
	};

	const discard = async (remote: Lix) => {
		if (current && (await current) === remote) current = null;
		await remote.close().catch(() => undefined);
	};

	return {
		async selectedBranch(): Promise<Lix> {
			const remote = await acquire();
			try {
				const branchId = activeBranchId();
				if ((await remote.activeBranchId()) !== branchId) {
					await remote.switchBranch({ branchId });
				}
				return remote;
			} catch (error) {
				await discard(remote);
				throw error;
			}
		},
		async snapshot(): Promise<Blob> {
			const remote = await acquire();
			try {
				// A snapshot contains every branch. Its export must not depend on
				// switching a diagnostic SQL session to the selected branch.
				return await new Response(remote.exportSnapshot(), {
					headers: { "Content-Type": "application/vnd.lix.snapshot" },
				}).blob();
			} catch (error) {
				await discard(remote);
				throw error;
			}
		},
		async close(): Promise<void> {
			closed = true;
			const opening = current;
			current = null;
			if (opening) {
				await opening.then((remote) => remote.close()).catch(() => undefined);
			}
		},
	};
}
