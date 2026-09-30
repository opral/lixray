import { repositoryErrorFrames } from "./repository-error-stack.ts";
export const REPOSITORY_OPEN_DIAGNOSTICS_PATH =
	"/api/repository-open-diagnostics";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MIGRATION_FAILURE_REASONS = [
	"receipt_json_syntax",
	"receipt_json_data",
	"receipt_json_eof",
	"receipt_json_other",
	"unsupported_receipt_version",
	"descriptor_version_invalid",
	"branch_control_missing",
	"branch_incarnation_mismatch",
	"baseline_lease_invalid",
	"receipt_validation_failed",
	"v2_receipt_shape_invalid",
	"v2_descriptor_version_invalid",
	"v2_branch_control_missing",
	"v2_branch_incarnation_mismatch",
	"v2_receipt_json_syntax",
	"v2_receipt_json_data",
	"v2_receipt_json_eof",
	"v2_receipt_json_other",
] as const;
const MIGRATION_FAILURE_PATHS = [
	"$",
	"$.descriptor.descriptorVersion",
	"$.descriptor.selectedBranch",
	"$.descriptor.globalBranch",
	"$.descriptor.selectedBranch.createdAt",
	"$.descriptor.globalBranch.createdAt",
	"$.baselineLease",
] as const;
const MIGRATION_PHASES = ["partial_receipt"] as const;
const PAYLOAD_FAILURE_REASONS = [
	"selected_change_payload_unavailable",
	"exact_owner_point_read_budget_exhausted",
] as const;
const EXACT_OWNER_POINT_READ_BUDGET = 65_536;
const MIGRATION_MISSING_FIELDS = [
	"version",
	"archivedBranchIds",
	"remoteId",
	"activeAccountId",
	"epochId",
	"descriptor",
	"baselineLease",
	"selectedServingGeneration",
	"globalServingGeneration",
	"descriptorVersion",
	"lixId",
	"defaultBranchId",
	"cursor",
	"selectedBranch",
	"globalBranch",
	"branchId",
	"createdAt",
	"updatedAt",
	"refChangeId",
	"head",
	"checkpoint",
	"commitId",
	"scopedRangeRootId",
	"scopedRangeRootDigest",
	"rowPkIndexRootId",
	"leaseId",
	"accountId",
	"roots",
	"expiresAtMs",
	"authorId",
] as const;

function isKnownMigrationMissingField(
	fields: Record<string, unknown>,
): boolean {
	const field = fields.missingField;
	if (
		typeof field !== "string" ||
		!MIGRATION_MISSING_FIELDS.includes(
			field as (typeof MIGRATION_MISSING_FIELDS)[number],
		)
	)
		return false;
	const version =
		typeof fields.receiptVersion === "number"
			? fields.receiptVersion
			: typeof fields.receiptVersion === "string" &&
				  /^\d{1,3}$/.test(fields.receiptVersion)
				? Number(fields.receiptVersion)
				: undefined;
	if (field === "version") return true;
	if (version === 1)
		return field !== "archivedBranchIds" && field !== "authorId";
	if (version === 2) return field !== "authorId";
	return version === 3;
}

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
		"payloadSourceDeferred",
		"payloadPhysicalConflict",
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
		"changeId",
		"sourceCommitId",
	]) {
		const value = fields[key];
		if (value === null || (typeof value === "string" && UUID.test(value)))
			result[key] = value;
	}
	for (const key of ["payloadStandaloneStatus", "payloadPhysicalStatus"]) {
		const value = fields[key];
		if (
			typeof value === "string" &&
			[
				"absent",
				"matched",
				"identity_mismatch",
				"missing_snapshot",
				"lifetime_mismatch",
			].includes(value)
		)
			result[key] = value;
	}
	if (
		typeof fields.payloadFailureReason === "string" &&
		PAYLOAD_FAILURE_REASONS.includes(
			fields.payloadFailureReason as (typeof PAYLOAD_FAILURE_REASONS)[number],
		)
	)
		result.payloadFailureReason = fields.payloadFailureReason;
	if (
		fields.payloadFailureReason === "exact_owner_point_read_budget_exhausted" &&
		parseBoundedPayloadCount(
			fields.attempted,
			EXACT_OWNER_POINT_READ_BUDGET + 1,
		) ===
			EXACT_OWNER_POINT_READ_BUDGET + 1 &&
		parseBoundedPayloadCount(fields.budget, EXACT_OWNER_POINT_READ_BUDGET) ===
			EXACT_OWNER_POINT_READ_BUDGET
	) {
		result.attempted = EXACT_OWNER_POINT_READ_BUDGET + 1;
		result.budget = EXACT_OWNER_POINT_READ_BUDGET;
	}
	if (
		typeof fields.failureReason === "string" &&
		MIGRATION_FAILURE_REASONS.includes(
			fields.failureReason as (typeof MIGRATION_FAILURE_REASONS)[number],
		)
	)
		result.failureReason = fields.failureReason;
	if (
		typeof fields.failurePath === "string" &&
		MIGRATION_FAILURE_PATHS.includes(
			fields.failurePath as (typeof MIGRATION_FAILURE_PATHS)[number],
		)
	)
		result.failurePath = fields.failurePath;
	if (
		typeof fields.migrationPhase === "string" &&
		MIGRATION_PHASES.includes(
			fields.migrationPhase as (typeof MIGRATION_PHASES)[number],
		)
	)
		result.migrationPhase = fields.migrationPhase;
	if (isKnownMigrationMissingField(fields))
		result.missingField = fields.missingField as string;
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
	for (const key of ["jsonLine", "jsonColumn"] as const) {
		const value = fields[key];
		const number =
			typeof value === "number"
				? value
				: typeof value === "string" && /^\d{1,5}$/.test(value)
					? Number(value)
					: undefined;
		if (Number.isSafeInteger(number) && number! > 0 && number! <= 16_384)
			result[key] = number!;
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

function parseBoundedPayloadCount(
	value: unknown,
	max: number,
): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d{1,6}$/.test(value)
				? Number(value)
				: undefined;
	return Number.isSafeInteger(parsed) && parsed! >= 0 && parsed! <= max
		? parsed
		: undefined;
}

/** Build a PostHog-safe exception value from an allowlisted migration cause. */
export function repositoryOpenFailureMessage(
	value: unknown,
	fallback: string,
): string {
	const fields = repositoryOpenDiagnostics(value);
	const reason = fields.failureReason ?? fields.payloadFailureReason;
	if (typeof reason !== "string") return fallback;
	const path =
		typeof fields.failurePath === "string" ? ` at ${fields.failurePath}` : "";
	return `${fallback}: ${reason}${path}`;
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
