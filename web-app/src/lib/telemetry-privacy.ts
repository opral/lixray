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
 * repository content that text masking cannot protect.
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
	"repository_name",
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
	const classifiedProperties = classifyExceptionContext(
		scrubbableEvent.event,
		scrubbableEvent.properties,
	);
	const properties =
		scrubbableEvent.event === "$autocapture"
			? scrubAutocaptureProperties(classifiedProperties)
			: classifiedProperties;
	return {
		...scrubbableEvent,
		properties: scrubPostHogValue(properties),
	} as CaptureResult;
}

function classifyExceptionContext(
	event: string | undefined,
	value: unknown,
): unknown {
	if (event !== "$exception" || !isRecord(value)) return value;
	const exceptionList = value.$exception_list;
	if (
		!Array.isArray(exceptionList) ||
		!exceptionList.some(isOpaqueScriptError)
	) {
		return value;
	}

	const scriptOrigins = crossOriginScriptOrigins();
	return {
		...value,
		lixray_exception_context_quality: "opaque_cross_origin",
		...(scriptOrigins.length > 0
			? { lixray_cross_origin_script_origins_present: scriptOrigins }
			: {}),
	};
}

function isOpaqueScriptError(value: unknown): boolean {
	if (!isRecord(value) || value.value !== "Script error.") return false;
	const stacktrace = value.stacktrace;
	return (
		!isRecord(stacktrace) ||
		!Array.isArray(stacktrace.frames) ||
		stacktrace.frames.length === 0
	);
}

function crossOriginScriptOrigins(): string[] {
	if (typeof document === "undefined" || typeof location === "undefined") {
		return [];
	}
	return safeCrossOriginScriptOrigins(
		Array.from(document.scripts, (script) => script.src),
		document.baseURI,
		location.origin,
	);
}

export function safeCrossOriginScriptOrigins(
	scriptSources: string[],
	baseUrl: string,
	pageOrigin: string,
): string[] {
	const origins = new Set<string>();
	for (const source of scriptSources) {
		if (!source) continue;
		try {
			const url = new URL(source, baseUrl);
			if (
				(url.protocol === "https:" || url.protocol === "http:") &&
				url.origin !== pageOrigin
			) {
				origins.add(url.origin);
			}
		} catch {
			// Ignore malformed and non-URL script sources.
		}
	}
	return [...origins].sort().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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
	preserveExceptionValue = false,
): unknown {
	if (depth > 10) return undefined;
	if (typeof value === "string") {
		return scrubPostHogString(value, propertyKey);
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			scrubPostHogValue(
				item,
				depth + 1,
				propertyKey,
				propertyKey === "$exception_list",
			),
		);
	}
	if (!value || typeof value !== "object") return value;

	const scrubbed: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase();
		if (
			(SENSITIVE_DOM_ATTRIBUTE_KEYS.has(normalizedKey) &&
				!(preserveExceptionValue && normalizedKey === "value")) ||
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
	if (/^\/profile\/[^/]+(?:\/|$)/.test(pathname)) {
		return "/profile/:namespace";
	}
	if (/^\/@[^/]+\/[^/]+\/file(?:\/|$)/.test(pathname)) {
		return "/repository/:repository/file/:file";
	}
	if (/^\/@[^/]+\/[^/]+(?:\/|$)/.test(pathname)) {
		return "/repository/:repository";
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
			"/repository/:repository/file/:file",
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
