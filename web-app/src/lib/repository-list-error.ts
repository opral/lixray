import type { Properties } from "posthog-js";

const MAX_SUPABASE_ERROR_CODE_LENGTH = 200;

export type RepositoryListOperation =
	| "bootstrap_personal_namespace"
	| "list_accessible_lixes"
	| "repository_refresh";

interface SupabaseErrorShape {
	code?: unknown;
}

export class RepositoryListError extends Error {
	readonly operation: RepositoryListOperation;
	readonly httpStatus: number | undefined;
	readonly supabaseErrorCode: string | undefined;

	constructor(
		operation: RepositoryListOperation,
		response: { error: unknown; status?: number },
	) {
		super("Unable to load repositories");
		this.name = "RepositoryListError";
		this.operation = operation;
		this.httpStatus = response.status;
		const code =
			response.error && typeof response.error === "object"
				? (response.error as SupabaseErrorShape).code
				: undefined;
		this.supabaseErrorCode =
			typeof code === "string"
				? code.slice(0, MAX_SUPABASE_ERROR_CODE_LENGTH)
				: undefined;
	}
}

export function repositoryListTelemetryProperties(error: unknown): Properties {
	const failure = normalizeRepositoryListError(error);
	return {
		repository_operation: failure.operation,
		repository_request_endpoint:
			failure.operation === "repository_refresh"
				? "client"
				: `/rest/v1/rpc/${failure.operation}`,
		...(failure.httpStatus !== undefined
			? { repository_http_status: failure.httpStatus }
			: {}),
		...(failure.supabaseErrorCode
			? { supabase_error_code: failure.supabaseErrorCode }
			: {}),
	};
}

export function normalizeRepositoryListError(
	error: unknown,
): RepositoryListError {
	return error instanceof RepositoryListError
		? error
		: new RepositoryListError("repository_refresh", { error });
}
