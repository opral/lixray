import type { AtelierEvent } from "@opral/atelier";
import type { Lix } from "@lix-js/sdk";

const DOCUMENT_MODIFIED_THROTTLE_MS = 30_000;

type TelemetryCapture = (
	event: string,
	properties: Record<string, unknown>,
) => void;

interface AtelierTelemetryContext {
	lix?: Lix;
	repositoryId?: string;
	organizationId?: string;
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
				capture("document_open_attempted", {
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
				capture("document_viewed", {
					document_origin: event.documentOrigin,
					file_extension: fileExtensionProperty(event.filePath),
					view_kind: event.viewKind,
				});
				break;
			case "document_modified": {
				const capturedAt = now();
				const lastCapturedAt = lastModificationByPath.get(event.filePath);
				if (
					lastCapturedAt !== undefined &&
					capturedAt - lastCapturedAt < modificationThrottleMs
				) {
					break;
				}
				lastModificationByPath.set(event.filePath, capturedAt);
				capture("document_modified", {
					file_extension: fileExtensionProperty(event.filePath),
					modified_by: event.modifiedBy,
				});

				// Track lixray_first_file_added event for repositories
				if (context.lix && context.repositoryId && context.organizationId) {
					const firstFileKey = `lixray.first-file.${context.repositoryId}`;
					const hasTrackedFirstFile =
						typeof window !== "undefined"
							? window.localStorage.getItem(firstFileKey)
							: null;

					if (!hasTrackedFirstFile) {
						void (async () => {
							try {
								// Check if this is the first file in the repository
								const result = await context.lix!.execute(
									"SELECT COUNT(*) as count FROM lix_file",
									[],
								);
								const row = result.rows[0] as
									| { get(column: string): unknown }
									| undefined;
								const fileCount = Number(row?.get("count") ?? 0);

								// If there's exactly 1 file, this is the first one
								if (fileCount === 1) {
									capture("lixray_first_file_added", {
										repository_id: context.repositoryId!,
										organization_id: context.organizationId!,
										file_extension: fileExtensionProperty(event.filePath),
									});
									if (typeof window !== "undefined") {
										window.localStorage.setItem(firstFileKey, "true");
									}
								}
							} catch (error) {
								console.warn("Failed to check first file status", error);
							}
						})();
					}
				}
				break;
			}
			case "extension_opened":
				capture("extension_opened", {
					extension_id: normalizeExtensionId(event.extensionId),
					panel: event.panel,
				});
				break;
			case "diff_opened":
				capture("diff_opened", {
					file_extension: fileExtensionProperty(event.filePath),
				});
				break;
			case "diff_resolved":
				capture("diff_resolved", {
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
