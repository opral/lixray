import type { LixTelemetrySpan } from "@lix-js/sdk";

/** Built-in anonymous Lix account. Never a PostHog person. */
export const ANONYMOUS_LIX_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";

export const LIX_REPOSITORY_OPENED_SPAN_NAME = "lix.repository.opened";
export const LIX_REPOSITORY_OPENED_AI_SPAN_EVENT = "$ai_span";

export type RepositoryOpenedSource = "web" | "mcp" | "server";

export interface LixRepositoryOpenedAiSpan {
	event: typeof LIX_REPOSITORY_OPENED_AI_SPAN_EVENT;
	distinctId: string;
	properties: {
		$ai_span_name: typeof LIX_REPOSITORY_OPENED_SPAN_NAME;
		$ai_trace_id?: string;
		$ai_span_id?: string;
		lix_id: string;
		branch_id?: string;
		repository_id?: string;
		organization_id?: string;
		environment: string;
		source?: RepositoryOpenedSource;
	};
}

export type LixOpenedSpanLike = Pick<
	LixTelemetrySpan,
	"name" | "attributes"
> & {
	traceId?: string;
	spanId?: string;
	start?: {
		kind?: string;
		name?: string;
		attributes?: unknown;
	};
};

export function identifiedDistinctId(
	accountId: string | null | undefined,
): string | null {
	const distinctId = accountId?.trim();
	if (
		!distinctId ||
		distinctId === ANONYMOUS_LIX_ACCOUNT_ID ||
		distinctId === "lixray-demo"
	) {
		return null;
	}
	return distinctId;
}

export function isLixRepositoryOpenedSpan(span: LixOpenedSpanLike): boolean {
	if (span.name === LIX_REPOSITORY_OPENED_SPAN_NAME) return true;
	return span.start?.name === LIX_REPOSITORY_OPENED_SPAN_NAME;
}

/**
 * Maps a completed Lix `lix.repository.opened` span to a PostHog `$ai_span`.
 * This is a capture of the engine span, not a parallel product event.
 * Missing Lix ids are omitted; duration is never invented.
 */
export function repositoryOpenedAiSpanFromLixSpan(
	span: LixOpenedSpanLike,
	options: {
		environment: string;
		source?: RepositoryOpenedSource;
		organizationId?: string;
		repositoryId?: string;
		distinctId?: string;
	},
): LixRepositoryOpenedAiSpan | null {
	if (!isLixRepositoryOpenedSpan(span)) return null;
	const attributes = spanAttributes(span);
	const distinctId = identifiedDistinctId(
		options.distinctId ?? stringAttribute(attributes, "lix.account_id"),
	);
	const lixId = stringAttribute(attributes, "lix.id") ?? "";
	if (!distinctId || !lixId) return null;
	const branchId = stringAttribute(attributes, "lix.branch_id");
	const organizationId = options.organizationId?.trim();
	const repositoryId = options.repositoryId?.trim() || lixId;
	const traceId = span.traceId?.trim();
	const spanId = span.spanId?.trim();
	return {
		event: LIX_REPOSITORY_OPENED_AI_SPAN_EVENT,
		distinctId,
		properties: {
			$ai_span_name: LIX_REPOSITORY_OPENED_SPAN_NAME,
			...(traceId ? { $ai_trace_id: traceId } : {}),
			...(spanId ? { $ai_span_id: spanId } : {}),
			lix_id: lixId,
			...(branchId ? { branch_id: branchId } : {}),
			repository_id: repositoryId,
			...(organizationId ? { organization_id: organizationId } : {}),
			environment: options.environment,
			...(options.source ? { source: options.source } : {}),
		},
	};
}

/**
 * In-process `openLix({ telemetry: { onSpan } })` adapter.
 * Remote/sync mode must not attach this: `lix.repository.opened` stays on
 * the server HostTelemetrySink `$ai_span` capture.
 */
export function createLixOpenedOnSpan(options: {
	capture: (event: LixRepositoryOpenedAiSpan) => void;
	environment: string;
	source?: RepositoryOpenedSource;
	organizationId?: string;
	repositoryId?: string;
	distinctId?: string;
}): (span: LixOpenedSpanLike) => void {
	return (span) => {
		const event = repositoryOpenedAiSpanFromLixSpan(span, options);
		if (event) options.capture(event);
	};
}

function spanAttributes(
	span: LixOpenedSpanLike,
): Record<string, string | number | boolean> {
	if (
		span.attributes &&
		!Array.isArray(span.attributes) &&
		Object.keys(span.attributes).length > 0
	) {
		return span.attributes;
	}
	const startAttributes = span.start?.attributes;
	if (startAttributes && !Array.isArray(startAttributes)) {
		return startAttributes as Record<string, string | number | boolean>;
	}
	if (Array.isArray(startAttributes)) {
		const attributes: Record<string, string | number | boolean> = {};
		const rawAttributes: unknown[] = startAttributes;
		for (const attribute of rawAttributes) {
			if (
				attribute &&
				typeof attribute === "object" &&
				"key" in attribute &&
				"value" in attribute &&
				typeof attribute.key === "string"
			) {
				const value = attributeValue(attribute.value);
				if (value !== undefined) attributes[attribute.key] = value;
			}
		}
		return attributes;
	}
	return {};
}

function attributeValue(value: unknown): string | number | boolean | undefined {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (value && typeof value === "object") {
		if ("String" in value && typeof value.String === "string") {
			return value.String;
		}
		if ("string" in value && typeof value.string === "string") {
			return value.string;
		}
	}
	return undefined;
}

function stringAttribute(
	attributes: Record<string, string | number | boolean>,
	key: string,
): string | undefined {
	const value = attributes[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
