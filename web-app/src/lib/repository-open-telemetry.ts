import { repositoryErrorFrames } from "./repository-error-stack.ts";
export const REPOSITORY_OPEN_DIAGNOSTICS_PATH =
	"/api/repository-open-diagnostics";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Only structural coordinates: never messages, URLs, credentials or document data. */
export function repositoryOpenDiagnostics(
	error: unknown,
): Record<string, string | number | null> {
	const result: Record<string, string | number | null> = {};
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
	]) {
		const value = fields[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
			result[key] = value;
		else if (typeof value === "string" && /^\d{1,20}$/.test(value))
			result[key] = value;
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
