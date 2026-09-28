import type { AtelierEvent } from "@opral/atelier";
import type { Lix } from "@lix-js/sdk";
import { PRODUCT_EVENTS, type ProductEvent } from "./telemetry-events.ts";

const DOCUMENT_MODIFIED_THROTTLE_MS = 30_000;

type TelemetryCapture = (
	event: ProductEvent,
	properties: Record<string, unknown>,
) => void;

interface AtelierTelemetryContext {
	lix?: Lix;
	repositoryId?: string;
	organizationId?: string;
	reportFirstFile?: (input: {
		repositoryId: string;
		before: string;
		after: string;
		fileExtension: string;
	}) => Promise<void>;
	reportInventory?: (input: {
		repositoryId: string;
		commitId: string;
	}) => Promise<void>;
}

export function createAtelierTelemetryHandler(
	capture: TelemetryCapture,
	options: {
		now?: () => number;
		modificationThrottleMs?: number;
		context?: AtelierTelemetryContext;
	} = {},
): (event: AtelierEvent) => void {
	const now = options.now ?? Date.now;
	const modificationThrottleMs =
		options.modificationThrottleMs ?? DOCUMENT_MODIFIED_THROTTLE_MS;
	const lastModificationByPath = new Map<string, number>();
	const context = options.context ?? {};

	return (event) => {
		switch (event.type) {
			case "document_open_attempted": {
				const fileExtension = fileExtensionProperty(event.filePath);
				capture(PRODUCT_EVENTS.documentOpenAttempted, {
					document_open_result: event.supported ? "viewed" : "unsupported",
					file_extension: fileExtension,
					...(event.supported
						? {}
						: {
								unsupported_reason:
									fileExtension === "(none)" ? "no_extension" : "no_renderer",
							}),
					document_origin: event.documentOrigin,
					view_kind: event.viewKind,
				});
				break;
			}
			case "document_viewed":
				capture(PRODUCT_EVENTS.documentViewed, {
					document_origin: event.documentOrigin,
					file_extension: fileExtensionProperty(event.filePath),
					view_kind: event.viewKind,
				});
				break;
			case "document_loaded":
				capture(PRODUCT_EVENTS.documentLoaded, {
					file_extension: fileExtensionProperty(event.filePath),
					view_kind: event.viewKind,
					duration_ms: event.durationMs,
				});
				break;
			case "document_modified": {
				if (context.repositoryId && context.reportInventory && event.commit) {
					void context
						.reportInventory({
							repositoryId: context.repositoryId,
							commitId: event.commit.after,
						})
						.catch((error: unknown) =>
							console.warn("Failed to report repository inventory", error),
						);
				}
				const capturedAt = now();
				const lastCapturedAt = lastModificationByPath.get(event.filePath);
				if (
					lastCapturedAt !== undefined &&
					capturedAt - lastCapturedAt < modificationThrottleMs
				) {
					break;
				}
				lastModificationByPath.set(event.filePath, capturedAt);
				capture(PRODUCT_EVENTS.documentModified, {
					file_extension: fileExtensionProperty(event.filePath),
					modified_by: event.modifiedBy,
				});

				// Use the write's commit, not the current working state or localStorage.
				if (
					context.lix &&
					context.repositoryId &&
					context.reportFirstFile &&
					event.commit
				) {
					const { before, after } = event.commit;
					void (async () => {
						try {
							const beforeResult = await context.lix!.execute(
								"SELECT COUNT(*) AS count FROM lix_as_of('lix_file', $1) WHERE path NOT LIKE '/.lix/%'",
								[before],
							);
							if (Number(beforeResult.rows[0]?.count) !== 0) return;
							const afterResult = await context.lix!.execute(
								"SELECT COUNT(*) AS count FROM lix_as_of('lix_file', $1) WHERE path NOT LIKE '/.lix/%'",
								[after],
							);
							if (Number(afterResult.rows[0]?.count) < 1) return;
							await context.reportFirstFile!({
								repositoryId: context.repositoryId!,
								before,
								after,
								fileExtension: fileExtensionProperty(event.filePath),
							});
						} catch (error) {
							console.warn("Failed to report first-file milestone", error);
						}
					})();
				}
				break;
			}
			case "extension_opened":
				capture(PRODUCT_EVENTS.extensionOpened, {
					extension_id: normalizeExtensionId(event.extensionId),
					panel: event.area,
				});
				break;
			case "diff_opened":
				capture(PRODUCT_EVENTS.diffOpened, {
					file_extension: fileExtensionProperty(event.filePath),
				});
				break;
			case "diff_resolved":
				capture(PRODUCT_EVENTS.diffResolved, {
					file_extension: fileExtensionProperty(event.filePath),
					outcome: event.outcome,
				});
				break;
			case "document_closed":
				break;
		}
	};
}

export function fileExtensionProperty(filePath: string): string {
	const fileName = filePath.split("/").pop() ?? filePath;
	const match = fileName.match(/\.([^./]+)$/);
	if (!match?.[1]) return "(none)";
	return (
		match[1]
			.toLowerCase()
			.replace(/[^a-z0-9+_-]/g, "")
			.slice(0, 20) || "(unknown)"
	);
}

function normalizeExtensionId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "_")
		.slice(0, 100);
}
