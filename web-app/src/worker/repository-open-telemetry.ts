import { repositoryOpenDiagnostics } from "../lib/repository-open-telemetry.ts";
import {
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";
import type { WorkerEnv } from "./handler.ts";

export function parseRepositoryOpenReport(body: unknown) {
	if (!body || typeof body !== "object") return null;
	const input = body as Record<string, unknown>;
	if (
		typeof input.repositoryId !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
			input.repositoryId,
		)
	)
		return null;
	if (!input.diagnostic || typeof input.diagnostic !== "object") return null;
	const diagnostic = input.diagnostic as Record<string, unknown>;
	const fields = repositoryOpenDiagnostics({
		code: diagnostic.lix_error_code,
		name: diagnostic.error_kind,
		details: diagnostic,
	});
	const release =
		typeof input.release === "string" && /^[a-f0-9]{40}$/.test(input.release)
			? input.release
			: "unknown";
	return { repositoryId: input.repositoryId, release, fields };
}

export async function captureRepositoryOpenReport(
	report: NonNullable<ReturnType<typeof parseRepositoryOpenReport>>,
	userId: string,
	env: WorkerEnv,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	const properties = {
		...report.fields,
		operation: "repository_open",
		surface: "web",
		delivery: "first_party",
		lix_id: report.repositoryId,
		client_release: report.release,
		server_release: env.LIXRAY_RELEASE_ID ?? "unknown",
		environment: "production",
	};
	// This bounded structural record survives a downstream ingestion failure.
	console.error("Repository open failed", properties);
	const token = resolvePosthogProjectToken(env);
	if (!token || !isProductionTelemetryEnvironment(env)) return false;
	try {
		const response = await fetcher(
			new URL("/capture/", env.POSTHOG_HOST || "https://us.i.posthog.com"),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					api_key: token,
					event: "$exception",
					properties: {
						...properties,
						distinct_id: userId,
						$exception_list: [
							{
								type:
									report.fields.lix_error_code ??
									report.fields.error_kind ??
									"RepositoryOpenError",
								value: "Repository opening failed",
								mechanism: { handled: true, type: "generic" },
							},
						],
					},
				}),
				signal: AbortSignal.timeout(4_000),
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}
