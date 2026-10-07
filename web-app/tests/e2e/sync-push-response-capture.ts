export const MAX_SYNC_PUSH_ERROR_BODY_BYTES = 4_096;

export type SyncPushResponseBody = {
	status(): number;
	headers(): Record<string, string>;
	body(): Promise<Uint8Array>;
};

export type SyncPushErrorCapture = {
	errorCode: string | null;
	bodyIssue: string | null;
};

export function isSyncPushProtocolRequest(
	method: string,
	url: string,
): boolean {
	if (method !== "POST") return false;
	try {
		const parsedUrl = new URL(url);
		return (
			["http:", "https:"].includes(parsedUrl.protocol) &&
			/^\/lix\/v1\/[^/]+\/sync\/push$/.test(parsedUrl.pathname) &&
			!parsedUrl.search &&
			!parsedUrl.hash
		);
	} catch {
		return false;
	}
}

function safeErrorCode(body: Uint8Array): string | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
		if (!parsed || typeof parsed !== "object" || !("error" in parsed))
			return null;
		const error = parsed.error;
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			typeof error.code !== "string" ||
			error.code.length > 128 ||
			!/^[A-Z0-9_.-]+$/.test(error.code)
		)
			return null;
		return error.code;
	} catch {
		return null;
	}
}

/** Read only a bounded JSON 503 body and retain only its safe error code. */
export async function captureSyncPushError(
	response: SyncPushResponseBody,
): Promise<SyncPushErrorCapture> {
	if (response.status() !== 503) {
		return {
			errorCode: null,
			bodyIssue: "response is not a 503",
		};
	}
	const contentLength = Number(response.headers()["content-length"]);
	if (
		Number.isSafeInteger(contentLength) &&
		contentLength > MAX_SYNC_PUSH_ERROR_BODY_BYTES
	) {
		return {
			errorCode: null,
			bodyIssue: `response body exceeds ${MAX_SYNC_PUSH_ERROR_BODY_BYTES}-byte classification limit`,
		};
	}

	let body: Uint8Array;
	try {
		body = await response.body();
	} catch (error) {
		const name =
			error instanceof Error && error.name ? error.name.slice(0, 64) : "Error";
		return {
			errorCode: null,
			bodyIssue: `response body unavailable (${name})`,
		};
	}
	if (body.byteLength > MAX_SYNC_PUSH_ERROR_BODY_BYTES) {
		return {
			errorCode: null,
			bodyIssue: `response body exceeds ${MAX_SYNC_PUSH_ERROR_BODY_BYTES}-byte classification limit`,
		};
	}
	const errorCode = safeErrorCode(body);
	return {
		errorCode,
		bodyIssue: errorCode
			? null
			: "response body did not contain a recognized error code",
	};
}

/** Treat only known client-side route cancellation as an expected fulfill failure. */
export function isClientCanceledSyncProxyRequest(
	error: unknown,
	requestFailure: string | null,
): boolean {
	if (requestFailure && /\b(?:net::)?ERR_ABORTED\b/i.test(requestFailure))
		return true;
	const message = error instanceof Error ? error.message : String(error);
	return /Target page, context or browser has been closed/i.test(message);
}
