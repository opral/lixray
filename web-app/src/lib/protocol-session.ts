export const PROTOCOL_SESSION_GONE_CODE = "LIX_ERROR_PROTOCOL_SESSION_GONE";
export const REMOTE_SESSION_EXPIRED_CODE = "LIX_REMOTE_SESSION_EXPIRED";

const PROTOCOL_SESSION_GONE_CODES = new Set([
	PROTOCOL_SESSION_GONE_CODE,
	REMOTE_SESSION_EXPIRED_CODE,
]);

export function isProtocolSessionGoneStatus(
	status: number | undefined,
	code?: string,
): boolean {
	if (status === 410) return true;
	return isProtocolSessionGoneCode(code);
}

export function isProtocolSessionGoneCode(code: string | undefined): boolean {
	return typeof code === "string" && PROTOCOL_SESSION_GONE_CODES.has(code);
}

export function protocolSessionGoneErrorCode(
	status: number,
	code?: string,
): string | undefined {
	if (code) return code;
	return status === 410 ? PROTOCOL_SESSION_GONE_CODE : undefined;
}
