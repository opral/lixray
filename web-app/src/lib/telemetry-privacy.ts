import type { CaptureResult } from "posthog-js";

export const AUTOCAPTURE_ATTRIBUTE_IGNORELIST = [
	"aria-label",
	"title",
	"href",
	"src",
	"srcset",
	"alt",
	"value",
	"placeholder",
	"data-testid",
	"data-view-instance",
	"data-view-key",
];

export const AUTOCAPTURE_SELECTOR_IGNORELIST = [
	".ph-no-autocapture",
	"[data-ph-no-autocapture]",
	".ph-no-capture",
	"[data-ph-no-capture]",
];

/**
 * Text and inputs are masked globally. Rich document surfaces are blocked as a
 * second layer because images, canvases, and embedded HTML can contain private
 * workspace content that text masking cannot protect.
 */
export const SESSION_RECORDING_BLOCK_SELECTOR = [
	".ph-no-capture",
	"[data-ph-no-capture]",
	"[data-attr='markdown-editor']",
	".atelier-image-canvas",
	"img",
	"iframe",
	"canvas",
].join(", ");

const SENSITIVE_DOM_ATTRIBUTE_KEYS = new Set([
	"alt",
	"aria-label",
	"data-testid",
	"data-view-instance",
	"data-view-key",
	"href",
	"placeholder",
	"src",
	"srcset",
	"title",
	"value",
]);

const SENSITIVE_EVENT_PROPERTY_KEYS = new Set([
	"access_token",
	"authorization",
	"document_content",
	"file_content",
	"file_name",
	"file_path",
	"invite_token",
	"organization_name",
	"refresh_token",
	"sql",
	"workspace_name",
]);

const URL_PROPERTY_KEYS = new Set([
	"$current_url",
	"$prev_pageview_pathname",
	"$prev_pageview_url",
	"$referrer",
	"$referring_domain",
	"$pathname",
]);

type ScrubbableCaptureResult = CaptureResult & {
	event?: string;
	properties?: unknown;
};

export function scrubPostHogEvent(
	event: CaptureResult | null,
): CaptureResult | null {
	if (!event) return event;
	const scrubbableEvent = event as ScrubbableCaptureResult;
	const properties =
		scrubbableEvent.event === "$autocapture"
			? scrubAutocaptureProperties(scrubbableEvent.properties)
			: scrubbableEvent.properties;
	return {
		...scrubbableEvent,
		properties: scrubPostHogValue(properties),
	} as CaptureResult;
}

function scrubAutocaptureProperties(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => scrubAutocaptureProperties(item));
	}
	if (!value || typeof value !== "object") return value;

	const scrubbed: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (key === "$el_text" || key === "$external_click_url") continue;
		if (key.startsWith("attr__") && key !== "attr__data-attr") continue;
		scrubbed[key] = scrubAutocaptureProperties(nestedValue);
	}
	return scrubbed;
}

function scrubPostHogValue(
	value: unknown,
	depth = 0,
	propertyKey?: string,
): unknown {
	if (depth > 10) return undefined;
	if (typeof value === "string") {
		return scrubPostHogString(value, propertyKey);
	}
	if (Array.isArray(value)) {
		return value.map((item) => scrubPostHogValue(item, depth + 1, propertyKey));
	}
	if (!value || typeof value !== "object") return value;

	const scrubbed: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase();
		if (
			SENSITIVE_DOM_ATTRIBUTE_KEYS.has(normalizedKey) ||
			SENSITIVE_EVENT_PROPERTY_KEYS.has(normalizedKey)
		) {
			continue;
		}
		const scrubbedValue = scrubPostHogValue(nestedValue, depth + 1, key);
		if (scrubbedValue !== undefined) scrubbed[key] = scrubbedValue;
	}
	return scrubbed;
}

export function sanitizeLixrayPathname(value: string): string {
	const pathname = value.split(/[?#]/, 1)[0] || "/";
	if (/^\/@[^/]+\/[^/]+\/file(?:\/|$)/.test(pathname)) {
		return "/workspace/:workspace/file/:file";
	}
	if (/^\/@[^/]+\/[^/]+(?:\/|$)/.test(pathname)) {
		return "/workspace/:workspace";
	}
	return pathname;
}

function scrubPostHogString(value: string, propertyKey?: string): string {
	if (propertyKey && URL_PROPERTY_KEYS.has(propertyKey)) {
		if (propertyKey === "$referring_domain") return hostnameOnly(value);
		if (propertyKey === "$referrer") return referrerOrigin(value);
		return sanitizeUrlOrPath(value);
	}

	return value
		.replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
		.replaceAll(
			/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
			"[redacted_token]",
		)
		.replaceAll(/file:\/\/\/[^\s)"'<>[\]{}]+/g, "[redacted_path]")
		.replaceAll(
			/\/(?:Users|Volumes|private|tmp|var)\/[^\s)"'<>[\]{}]+/g,
			"[redacted_path]",
		)
		.replaceAll(/[A-Za-z]:\\[^\s)"'<>[\]{}]+/g, "[redacted_path]")
		.replaceAll(
			/\/@[^/\s]+\/[^/\s]+\/file(?:\/[^\s)"'<>[\]{}]*)?/g,
			"/workspace/:workspace/file/:file",
		);
}

function sanitizeUrlOrPath(value: string): string {
	if (value.startsWith("/")) return sanitizeLixrayPathname(value);
	try {
		const url = new URL(value);
		return `${url.origin}${sanitizeLixrayPathname(url.pathname)}`;
	} catch {
		return sanitizeLixrayPathname(value);
	}
}

function referrerOrigin(value: string): string {
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}

function hostnameOnly(value: string): string {
	try {
		return value.includes("://")
			? new URL(value).hostname
			: value.split("/")[0];
	} catch {
		return "";
	}
}
