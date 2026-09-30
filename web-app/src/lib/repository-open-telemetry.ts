import { repositoryErrorFrames } from "./repository-error-stack.ts";
export const REPOSITORY_OPEN_DIAGNOSTICS_PATH =
	"/api/repository-open-diagnostics";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Only structural coordinates: never messages, URLs, credentials or document data. */
export function repositoryOpenDiagnostics(
	error: unknown,
): Record<string, string | number | boolean | null> {
	const result: Record<string, string | number | boolean | null> = {};
	if (!error || typeof error !== "object") return result;
	const candidate = error as Record<string, unknown>;
	if (
		typeof candidate.name === "string" &&
		[
			"Error",
			"TypeError",
			"RangeError",
			"ReferenceError",
			"SyntaxError",
			"AbortError",
			"TimeoutError",
			"QuotaExceededError",
			"SecurityError",
			"NotFoundError",
			"InvalidStateError",
			"NetworkError",
			"LixError",
		].includes(candidate.name)
	)
		result.error_kind = candidate.name;
	if (
		typeof candidate.code === "string" &&
		/^LIX_[A-Z0-9_]{1,100}$/.test(candidate.code)
	)
		result.lix_error_code = candidate.code;
	const details = candidate.details;
	if (!details || typeof details !== "object") return result;
	const fields = details as Record<string, unknown>;
	for (const key of [
		"retryable",
		"admissionRetryExhausted",
		"recoveryDeadlineExceeded",
	]) {
		if (typeof fields[key] === "boolean") result[key] = fields[key];
	}
	if (
		typeof fields.sourceCode === "string" &&
		/^LIX_[A-Z0-9_]{1,100}$/.test(fields.sourceCode)
	)
		result.sourceCode = fields.sourceCode;
	for (const key of [
		"branchId",
		"headCommitId",
		"rootCommitId",
		"expectedRootCommitId",
		"servingGeneration",
		"expectedServingGeneration",
	]) {
		const value = fields[key];
		if (value === null || (typeof value === "string" && UUID.test(value)))
			result[key] = value;
	}
	for (const key of [
		"servingGeneration",
		"expectedServingGeneration",
		"rootBytes",
		"httpStatus",
		"storageEpoch",
		"expectedStorageEpoch",
		"protocolEpoch",
		"expectedProtocolEpoch",
		"fromVersion",
		"toVersion",
		"receiptVersion",
		"expectedReceiptVersion",
		"recoveryAttempts",
	]) {
		const value = fields[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
			result[key] = value;
		else if (typeof value === "string" && /^\d{1,20}$/.test(value))
			result[key] = Number.isSafeInteger(Number(value)) ? Number(value) : value;
	}
	if (
		fields.recoveryStage === "admission" ||
		fields.recoveryStage === "replacement"
	)
		result.recoveryStage = fields.recoveryStage;
	for (const [key, field, length] of [
		["telemetryTraceId", "$otel_trace_id", 32],
		["telemetrySpanId", "$otel_span_id", 16],
	] as const) {
		const value = fields[key] ?? fields[field];
		if (
			typeof value === "string" &&
			new RegExp(`^[a-f0-9]{${length}}$`).test(value) &&
			/[1-9a-f]/.test(value)
		)
			result[field] = value;
	}
	return result;
}

export async function reportRepositoryOpenFailure(
	error: unknown,
	context: {
		repositoryId: string;
		release: string;
		getAccessToken: () => Promise<string | null>;
	},
	fetcher: typeof fetch = fetch,
): Promise<void> {
	try {
		const token = await context.getAccessToken();
		await fetcher(REPOSITORY_OPEN_DIAGNOSTICS_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				repositoryId: context.repositoryId,
				release: context.release,
				diagnostic: repositoryOpenDiagnostics(error),
				frames: repositoryErrorFrames(error),
			}),
			signal: AbortSignal.timeout(8_000),
			keepalive: true,
		});
	} catch {
		/* Diagnostics must never replace the opening error. */
	}
}
