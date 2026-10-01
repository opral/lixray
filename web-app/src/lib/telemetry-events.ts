/**
 * Canonical product analytics events.
 *
 * Event names describe the business behavior. The emitting client belongs in
 * the `surface` property, never in a `webapp_`, `mcp_`, or `lixray_` prefix.
 * PostHog-owned `$*` events and OpenTelemetry span names are intentionally not
 * part of this registry.
 */
export const PRODUCT_EVENTS = {
	authSessionOrphaned: "auth_session_orphaned",
	diffOpened: "diff_opened",
	diffResolved: "diff_resolved",
	documentLoaded: "document_loaded",
	documentModified: "document_modified",
	documentOpenAttempted: "document_open_attempted",
	documentViewed: "document_viewed",
	extensionOpened: "extension_opened",
	fileWritten: "file_written",
	firstFileAdded: "first_file_added",
	importCompleted: "import_completed",
	oauthConsentResolved: "oauth_consent_resolved",
	organizationCreated: "organization_created",
	organizationRenamed: "organization_renamed",
	repositoryCreated: "repository_created",
	repositoryOpenPerformance: "repository_open_performance",
	repositoryInventorySnapshot: "repository_inventory_snapshot",
	repositoryDeleted: "repository_deleted",
	repositoryRenamed: "repository_renamed",
	resourcePublished: "resource_published",
	resourceUnpublished: "resource_unpublished",
	shareLinkCopied: "share_link_copied",
	userSignedUp: "user_signed_up",
} as const;

export type ProductEvent = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];
export type TelemetrySurface = "web" | "mcp" | "server";
