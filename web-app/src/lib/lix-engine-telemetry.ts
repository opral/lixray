/**
 * Forwards Lix engine spans. LixRay does not invent SQL / open / checkpoint
 * clocks. Names, ids, duration, and attributes come from Lix `onSpan` only.
 */

export const LIX_ENGINE_AI_SPAN_EVENT = "$ai_span";
const LIX_OPENED_SPAN_NAME = "lix.opened";

export type LixEngineSpanLike = {
	schemaVersion?: number;
	name: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	durationMs?: number;
	status?: string;
	attributes?: Record<string, string | number | boolean>;
};

export type LixEngineAiSpan = {
	event: typeof LIX_ENGINE_AI_SPAN_EVENT;
	properties: {
		$ai_span_name: string;
		$ai_latency: number;
		$ai_is_error: boolean;
		$ai_trace_id?: string;
		$ai_span_id?: string;
		$ai_parent_id?: string;
		lix_attributes?: Record<string, string | number | boolean>;
	};
	lixId?: string;
};

export function isLixEnginePerfName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.startsWith("lix.") && trimmed !== LIX_OPENED_SPAN_NAME;
}

/**
 * Maps a completed Lix span to a PostHog `$ai_span`.
 *
 * `lix.opened` is not a timed product event; the host maps it to
 * `repository_opened`. `mcp.*` names are never a Lix engine clock.
 * Missing duration or Lix ids are omitted — they are not synthesized.
 */
export function lixEngineAiSpan(
	span: LixEngineSpanLike,
): LixEngineAiSpan | null {
	if (!isLixEnginePerfName(span.name)) return null;
	if (
		typeof span.durationMs !== "number" ||
		!Number.isFinite(span.durationMs)
	) {
		return null;
	}

	const properties: LixEngineAiSpan["properties"] = {
		$ai_span_name: span.name,
		$ai_latency: span.durationMs / 1000,
		$ai_is_error: span.status === "error",
	};
	const traceId = nonempty(span.traceId);
	const spanId = nonempty(span.spanId);
	const parentSpanId = nonempty(span.parentSpanId);
	if (traceId) properties.$ai_trace_id = traceId;
	if (spanId) properties.$ai_span_id = spanId;
	if (parentSpanId) properties.$ai_parent_id = parentSpanId;
	if (span.attributes && Object.keys(span.attributes).length > 0) {
		properties.lix_attributes = span.attributes;
	}

	return {
		event: LIX_ENGINE_AI_SPAN_EVENT,
		properties,
		lixId: stringAttribute(span.attributes, "lix.id"),
	};
}

export function createLixEngineOnSpan(
	capture: (event: LixEngineAiSpan) => void,
): (span: LixEngineSpanLike) => void {
	return (span) => {
		const event = lixEngineAiSpan(span);
		if (event) capture(event);
	};
}

function nonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function stringAttribute(
	attributes: Record<string, string | number | boolean> | undefined,
	key: string,
): string | undefined {
	const value = attributes?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
