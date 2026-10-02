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
	"db.statement",
	"document_content",
	"file_content",
	"file_name",
	"file_path",
	"http.response.body",
	"http.response_body",
	"httpresponsebody",
	"http_response_body",
	"invite_token",
	"lix_error_hint",
	"organization_name",
	"refresh_token",
	"response_body",
	"responsebody",
	"sql",
	"sql.query.text",
	"repository_name",
]);

const MAX_TELEMETRY_STRING_LENGTH = 16_384;

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
	const safeExceptionProperties = scrubNativeExceptionValues(
		scrubbableEvent.event,
		scrubbableEvent.properties,
	);
	const classifiedProperties = classifyExceptionContext(
		scrubbableEvent.event,
		safeExceptionProperties,
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

/** Native error messages can contain arbitrary SQL or repository identifiers. */
function scrubNativeExceptionValues(
	event: string | undefined,
	value: unknown,
): unknown {
	if (event !== "$exception" || !isRecord(value)) return value;
	const code = safeLixErrorCode(value.lix_error_code);
	const exceptionList = value.$exception_list;
	if (!isUnknownArray(exceptionList)) {
		const properties = { ...value };
		if (code) properties.lix_error_code = code;
		else delete properties.lix_error_code;
		delete properties.lix_error_hint;
		return properties;
	}
	const first = exceptionList[0];
	const primaryType = safeExceptionType(
		isRecord(first) ? first.type : undefined,
	);
	const hasNativeError = code !== undefined || primaryType === "LixError";
	const properties = { ...value };
	if (code) properties.lix_error_code = code;
	else delete properties.lix_error_code;
	delete properties.lix_error_hint;
	if (!hasNativeError) return properties;
	properties.$exception_list = exceptionList.map((exception, index) => {
		if (!isRecord(exception)) return exception;
		const type = safeExceptionType(exception.type) ?? "Error";
		return {
			...exception,
			type: index === 0 && code ? code : type,
			value: index === 0 ? (code ?? type) : `Caused by ${type}`,
		};
	});
	return properties;
}

function safeLixErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^LIX_[A-Z0-9_]{1,100}$/.test(value)
		? value
		: undefined;
}

function safeExceptionType(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(value)
		? value
		: undefined;
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
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
			SENSITIVE_EVENT_PROPERTY_KEYS.has(normalizedKey) ||
			normalizedKey === "vars"
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
	const input =
		propertyKey === "filename" ? sanitizeStackFrameFilename(value) : value;
	if (propertyKey && URL_PROPERTY_KEYS.has(propertyKey)) {
		if (propertyKey === "$referring_domain")
			return hostnameOnly(input).slice(0, MAX_TELEMETRY_STRING_LENGTH);
		if (propertyKey === "$referrer")
			return referrerOrigin(input).slice(0, MAX_TELEMETRY_STRING_LENGTH);
		return sanitizeUrlOrPath(input).slice(0, MAX_TELEMETRY_STRING_LENGTH);
	}

	const scrubbed = input
		.replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
		.replaceAll(/Basic\s+[A-Za-z0-9+/]+=*/gi, "Basic [redacted]")
		.replaceAll(
			/\b((?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*)[^\s,;"']+/gi,
			"$1[redacted]",
		)
		.replaceAll(/\blixray_pat_[A-Za-z0-9_-]+\b/g, "[redacted_token]")
		.replaceAll(
			/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
			"[redacted_token]",
		)
		.replaceAll(/file:\/\/\/[^\s)"'<>[\]{}]+/g, "[redacted_path]")
		.replaceAll(
			/\/(?:Users|Volumes|private|tmp|var|home|root)\/[^\s)"'<>[\]{}]+/g,
			"[redacted_path]",
		)
		.replaceAll(/[A-Za-z]:\\[^\s)"'<>[\]{}]+/g, "[redacted_path]")
		.replaceAll(
			/\/@[^/\s]+\/[^/\s]+\/file(?:\/[^\s)"'<>[\]{}]*)?/g,
			"/repository/:repository/file/:file",
		);
	return scrubDiagnosticContent(scrubbed).slice(0, MAX_TELEMETRY_STRING_LENGTH);
}

/** Sanitize untrusted exception text before it is serialized into an OTel span. */
export function sanitizeTelemetryDiagnostic(value: string): string {
	return scrubPostHogString(value);
}

function sanitizeStackFrameFilename(value: string): string {
	const withoutFragmentOrQuery = value.split(/[?#]/, 1)[0] || "";
	try {
		const url = new URL(withoutFragmentOrQuery);
		if (url.protocol === "http:" || url.protocol === "https:")
			return `${url.origin}${sanitizeLixrayPathname(url.pathname)}`;
	} catch {
		// Local and relative bundle paths are handled by the generic path scrubber.
	}
	return withoutFragmentOrQuery;
}

/** Preserve useful error context while removing common content-bearing text. */
function scrubDiagnosticContent(value: string): string {
	let sanitized = value
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(
			/([?&](?:[^=\s&]*(?:token|secret|password|signature|credential|key)[^=\s&]*)=)[^\s&#"']*/gi,
			"$1[redacted]",
		)
		.replace(
			/\/lix\/v1\/[0-9a-f-]{36}\/snapshot/gi,
			"/lix/v1/{lix_id}/snapshot",
		);
	const sql =
		/\b(?:WITH\b[\s\S]*?\bSELECT\b[\s\S]*?\bFROM\b|SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|SCHEMA)\b)/i.exec(
			sanitized,
		);
	if (sql?.index !== undefined)
		sanitized = `${sanitized.slice(0, sql.index)}[SQL statement omitted]`;
	const responseBody = /(?:response\s+(?:body|text)|http\s+body)\s*[:=]/i.exec(
		sanitized,
	);
	if (responseBody?.index !== undefined)
		sanitized = `${sanitized.slice(0, responseBody.index)}[response body omitted]`;
	const htmlBody = /<!doctype\s+html|<html\b|<body\b/i.exec(sanitized);
	if (htmlBody?.index !== undefined)
		sanitized = `${sanitized.slice(0, htmlBody.index)}[response body omitted]`;
	if (
		sanitized.trimStart().startsWith("{") ||
		sanitized.trimStart().startsWith("[")
	) {
		try {
			const parsed: unknown = JSON.parse(sanitized);
			if (parsed && typeof parsed === "object")
				sanitized = "[structured response body omitted]";
		} catch {
			// Keep ordinary diagnostics that happen to start with a brace.
		}
	}
	return sanitized;
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
