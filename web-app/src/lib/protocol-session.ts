export const PROTOCOL_SESSION_GONE_CODE = "LIX_ERROR_PROTOCOL_SESSION_GONE";
export const REMOTE_SESSION_EXPIRED_CODE = "LIX_REMOTE_SESSION_EXPIRED";

const PROTOCOL_SESSION_GONE_CODES = new Set([
	PROTOCOL_SESSION_GONE_CODE,
	REMOTE_SESSION_EXPIRED_CODE,
]);

const PROTOCOL_SESSION_GONE_MESSAGE =
	/protocol session is unknown, expired, or closed|open a new client session/i;

export const MAX_PROTOCOL_SESSION_RECOVERIES = 3;

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

export function isProtocolSessionGoneError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return typeof error === "string" && PROTOCOL_SESSION_GONE_MESSAGE.test(error);
	}
	const candidate = error as {
		code?: unknown;
		status?: unknown;
		message?: unknown;
	};
	const code = typeof candidate.code === "string" ? candidate.code : undefined;
	const status =
		typeof candidate.status === "number" ? candidate.status : undefined;
	if (isProtocolSessionGoneStatus(status, code)) return true;
	return typeof candidate.message === "string"
		? PROTOCOL_SESSION_GONE_MESSAGE.test(candidate.message)
		: false;
}

export function protocolSessionGoneErrorCode(
	status: number,
	code?: string,
): string | undefined {
	if (code) return code;
	return status === 410 ? PROTOCOL_SESSION_GONE_CODE : undefined;
}

export type ProtocolSessionRecovery = {
	recover: () => boolean;
	markReady: () => void;
	resetBudget: () => void;
	getEpoch: () => number;
};

export function createProtocolSessionRecovery(options?: {
	maxRecoveries?: number;
}): ProtocolSessionRecovery {
	const maxRecoveries =
		options?.maxRecoveries ?? MAX_PROTOCOL_SESSION_RECOVERIES;
	let epoch = 0;
	let recoveryCount = 0;
	let recovering = false;

	return {
		recover() {
			if (recovering || recoveryCount >= maxRecoveries) return false;
			recovering = true;
			recoveryCount += 1;
			epoch += 1;
			return true;
		},
		markReady() {
			recovering = false;
		},
		resetBudget() {
			recoveryCount = 0;
			recovering = false;
		},
		getEpoch() {
			return epoch;
		},
	};
}
