import type { LixTelemetrySpan } from "@lix-js/sdk";

/** Built-in anonymous Lix account. Never a PostHog person. */
export const ANONYMOUS_LIX_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";

export const LIX_OPENED_SPAN_NAME = "lix.opened";
export const REPOSITORY_OPENED_EVENT = "repository_opened";

export type RepositoryOpenedSource = "web" | "mcp" | "server";

export interface RepositoryOpenedEvent {
	event: typeof REPOSITORY_OPENED_EVENT;
	distinctId: string;
	properties: {
		lix_id: string;
		branch_id?: string;
		repository_id?: string;
		organization_id?: string;
		environment: string;
		source?: RepositoryOpenedSource;
	};
}

export interface LixOpenedBind {
	lixId: string;
	branchId?: string;
	accountId: string;
	organizationId?: string;
	repositoryId?: string;
	environment: string;
	source?: RepositoryOpenedSource;
}

export type LixOpenedSpanLike = Pick<
	LixTelemetrySpan,
	"name" | "attributes"
> & {
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

export function isLixOpenedSpan(span: LixOpenedSpanLike): boolean {
	if (span.name === LIX_OPENED_SPAN_NAME) return true;
	const start = span.start;
	if (!start) return false;
	return (
		start.name === LIX_OPENED_SPAN_NAME ||
		start.kind === "LixOpened" ||
		start.kind === LIX_OPENED_SPAN_NAME
	);
}

export function repositoryOpenedFromBind(
	bind: LixOpenedBind,
): RepositoryOpenedEvent | null {
	const distinctId = identifiedDistinctId(bind.accountId);
	const lixId = bind.lixId.trim();
	if (!distinctId || !lixId) return null;
	const branchId = bind.branchId?.trim();
	const organizationId = bind.organizationId?.trim();
	const repositoryId = bind.repositoryId?.trim() || lixId;
	return {
		event: REPOSITORY_OPENED_EVENT,
		distinctId,
		properties: {
			lix_id: lixId,
			...(branchId ? { branch_id: branchId } : {}),
			repository_id: repositoryId,
			...(organizationId ? { organization_id: organizationId } : {}),
			environment: bind.environment,
			...(bind.source ? { source: bind.source } : {}),
		},
	};
}

export function repositoryOpenedFromLixOpened(
	span: LixOpenedSpanLike,
	options: {
		environment: string;
		source?: RepositoryOpenedSource;
		organizationId?: string;
		repositoryId?: string;
		distinctId?: string;
	},
): RepositoryOpenedEvent | null {
	if (!isLixOpenedSpan(span)) return null;
	const attributes = spanAttributes(span);
	return repositoryOpenedFromBind({
		lixId: stringAttribute(attributes, "lix.id") ?? "",
		branchId: stringAttribute(attributes, "lix.branch_id"),
		accountId:
			options.distinctId ?? stringAttribute(attributes, "lix.account_id") ?? "",
		organizationId: options.organizationId,
		repositoryId: options.repositoryId,
		environment: options.environment,
		source: options.source,
	});
}

/**
 * In-process `openLix({ telemetry: { onSpan } })` adapter.
 * Remote mode must not attach this: `lix.opened` stays on the server.
 */
export function createLixOpenedOnSpan(options: {
	capture: (event: RepositoryOpenedEvent) => void;
	environment: string;
	source?: RepositoryOpenedSource;
	organizationId?: string;
	repositoryId?: string;
	distinctId?: string;
}): (span: LixOpenedSpanLike) => void {
	return (span) => {
		const event = repositoryOpenedFromLixOpened(span, options);
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
