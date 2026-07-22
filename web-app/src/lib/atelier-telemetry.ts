import type { AtelierEvent } from "@opral/atelier";

const DOCUMENT_MODIFIED_THROTTLE_MS = 30_000;

type TelemetryCapture = (
	event: string,
	properties: Record<string, unknown>,
) => void;

export function createAtelierTelemetryHandler(
	capture: TelemetryCapture,
	options: { now?: () => number; modificationThrottleMs?: number } = {},
): (event: AtelierEvent) => void {
	const now = options.now ?? Date.now;
	const modificationThrottleMs =
		options.modificationThrottleMs ?? DOCUMENT_MODIFIED_THROTTLE_MS;
	const lastModificationByPath = new Map<string, number>();

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
