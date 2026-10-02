export type RepositoryOpenProfileValue = string | number | boolean;
export type RepositoryOpenProfileAttributes = Record<
	string,
	RepositoryOpenProfileValue
>;

export interface RepositoryOpenPerformance {
	getEntriesByType?: (type: string) => ArrayLike<unknown>;
}

export interface RepositoryOpenProfileEntryList {
	getEntries: () => readonly unknown[];
}

export interface RepositoryOpenProfileObserver {
	observe: (options: { type: string; buffered: boolean }) => void;
	disconnect: () => void;
	takeRecords?: () => readonly unknown[];
}

export interface RepositoryOpenProfileObserverConstructor {
	new (
		callback: (list: RepositoryOpenProfileEntryList) => void,
	): RepositoryOpenProfileObserver;
}

export interface RepositoryOpenProfileNavigator {
	hardwareConcurrency?: unknown;
	deviceMemory?: unknown;
	connection?: { effectiveType?: unknown } | null;
	userAgent?: unknown;
}

export interface RepositoryOpenProfileDependencies {
	performance?: RepositoryOpenPerformance;
	PerformanceObserver?: RepositoryOpenProfileObserverConstructor | null;
	navigator?: RepositoryOpenProfileNavigator;
	origin?: string;
	/** PageTransitionEvent.persisted when the opening began after pageshow. */
	pagePersisted?: boolean;
}

export interface RepositoryOpenProfile {
	finish: (endTime: number) => RepositoryOpenProfileAttributes;
}

type ResourceCategory = "wasm" | "first_party_js" | "api" | "lix" | "other";

interface ResourceRecord {
	category: ResourceCategory;
	startTime: number;
	responseEnd: number;
	transferSize?: number;
}

interface LongTaskRecord {
	startTime: number;
	duration: number;
}

interface ResourceAggregate {
	count: number;
	durationMs: number;
	transferBytes: number;
}

const PREFIX = "lixray.repository.open.profile.";
const RESOURCE_CATEGORIES: readonly ResourceCategory[] = [
	"wasm",
	"first_party_js",
	"api",
	"lix",
	"other",
];
const MAX_RESOURCE_RECORDS = 1_000;
const MAX_LONG_TASK_RECORDS = 1_000;
const MAX_AGGREGATE_DURATION_MS = 3_600_000;
const MAX_AGGREGATE_BYTES = 1_000_000_000_000;

/**
 * Observe browser work for one repository-open interval. This performs no
 * requests and emits only timing, size, bounded category, and coarse device
 * context; resource URLs and names are discarded during observation.
 */
export function createRepositoryOpenProfile(
	startTime: number,
	dependencies: RepositoryOpenProfileDependencies = {},
): RepositoryOpenProfile {
	const validStartTime = isFiniteNonNegative(startTime);
	const intervalStart = validStartTime ? startTime : 0;
	const performanceApi = safeDependency(
		() => dependencies.performance ?? browserPerformance(),
	);
	const origin = safeDependency(() => dependencies.origin ?? browserOrigin());
	const navigatorApi = safeDependency(
		() => dependencies.navigator ?? browserNavigator(),
	);
	const observerConstructor = safeDependency(() =>
		Object.hasOwn(dependencies, "PerformanceObserver")
			? (dependencies.PerformanceObserver ?? undefined)
			: browserPerformanceObserver(),
	);
	const pagePersisted = safeDependency(() => dependencies.pagePersisted);
	const resourceRecords: ResourceRecord[] = [];
	const longTaskRecords: LongTaskRecord[] = [];
	const observers: Array<{
		type: "resource" | "longtask";
		observer: RepositoryOpenProfileObserver;
	}> = [];
	let resourcesTruncated = false;
	let longTasksTruncated = false;
	let resourceTimingSupported = false;
	let longTaskSupported = false;
	let finished = false;
	let finishedAttributes: RepositoryOpenProfileAttributes | undefined;

	const addObserver = (
		type: "resource" | "longtask",
		onEntries: (entries: readonly unknown[]) => void,
	): void => {
		if (!observerConstructor) return;
		let observer: RepositoryOpenProfileObserver | undefined;
		try {
			observer = new observerConstructor((list) => {
				if (finished) return;
				try {
					onEntries(list.getEntries());
				} catch {
					// Malformed browser entries cannot affect repository opening.
				}
			});
			observer.observe({ type, buffered: true });
			observers.push({ type, observer });
			if (type === "resource") resourceTimingSupported = true;
			else longTaskSupported = true;
		} catch {
			// Unsupported entry types and browser privacy restrictions are normal.
			try {
				observer?.disconnect();
			} catch {
				// Failed observer setup has no bearing on repository opening.
			}
		}
	};

	addObserver("resource", acceptResourceEntries);
	addObserver("longtask", acceptLongTaskEntries);

	function acceptResourceEntries(entries: readonly unknown[]): void {
		for (const entry of entries) {
			const record = resourceRecord(entry, origin);
			if (!record || record.responseEnd <= intervalStart) continue;
			if (resourceRecords.length >= MAX_RESOURCE_RECORDS) {
				resourcesTruncated = true;
				break;
			}
			resourceRecords.push(record);
		}
	}

	function acceptLongTaskEntries(entries: readonly unknown[]): void {
		for (const entry of entries) {
			const record = longTaskRecord(entry);
			if (!record || record.startTime + record.duration <= intervalStart)
				continue;
			if (longTaskRecords.length >= MAX_LONG_TASK_RECORDS) {
				longTasksTruncated = true;
				break;
			}
			longTaskRecords.push(record);
		}
	}

	return {
		finish(endTime) {
			if (finishedAttributes) return { ...finishedAttributes };
			const validEndTime =
				isFiniteNonNegative(endTime) && endTime >= intervalStart;
			const intervalEnd = validEndTime ? endTime : intervalStart;
			for (const { type, observer } of observers) {
				try {
					const pending = observer.takeRecords?.();
					if (pending) {
						if (type === "resource") acceptResourceEntries(pending);
						else acceptLongTaskEntries(pending);
					}
				} catch {
					// Draining is best effort; the profile is diagnostic only.
				}
			}
			finished = true;
			for (const { observer } of observers) {
				try {
					observer.disconnect();
				} catch {
					// Disconnect failures must never block opening.
				}
			}

			const attributes: RepositoryOpenProfileAttributes = {
				[`${PREFIX}navigation_timing_supported`]: false,
				[`${PREFIX}resource_timing_supported`]: resourceTimingSupported,
				[`${PREFIX}longtask_supported`]: longTaskSupported,
				[`${PREFIX}interval_valid`]: validStartTime && validEndTime,
			};
			addDeviceContext(attributes, navigatorApi);
			if (typeof pagePersisted === "boolean")
				attributes[`${PREFIX}page_persisted`] = pagePersisted;
			addNavigationTiming(
				attributes,
				performanceApi,
				validStartTime && startTime === 0,
			);
			if (resourceTimingSupported)
				addResourceAggregates(
					attributes,
					resourceRecords,
					intervalStart,
					intervalEnd,
					resourcesTruncated,
				);
			if (longTaskSupported)
				addLongTaskAggregates(
					attributes,
					longTaskRecords,
					intervalStart,
					intervalEnd,
					longTasksTruncated,
				);
			finishedAttributes = attributes;
			return { ...attributes };
		},
	};
}

function addNavigationTiming(
	attributes: RepositoryOpenProfileAttributes,
	performanceApi: RepositoryOpenPerformance | undefined,
	includeDocumentTimings: boolean,
): void {
	let entry: Record<string, unknown> | undefined;
	try {
		const entries = performanceApi?.getEntriesByType?.("navigation");
		if (entries && entries.length > 0) {
			const first = entries[0];
			if (first && typeof first === "object")
				entry = first as Record<string, unknown>;
		}
	} catch {
		// Navigation Timing can be disabled or wrapped by a hostile environment.
	}
	const supported = entry !== undefined;
	attributes[`${PREFIX}navigation_timing_supported`] = supported;
	if (!entry || !includeDocumentTimings) return;

	const type = safeField(entry, "type");
	if (
		type === "navigate" ||
		type === "reload" ||
		type === "back_forward" ||
		type === "prerender"
	)
		attributes[`${PREFIX}navigation_type`] = type;
	addTimingDifference(
		attributes,
		"dns_ms",
		entry,
		"domainLookupStart",
		"domainLookupEnd",
	);
	addTimingDifference(
		attributes,
		"connect_ms",
		entry,
		"connectStart",
		"connectEnd",
	);
	const secureConnectionStart = safeField(entry, "secureConnectionStart");
	const connectEnd = safeField(entry, "connectEnd");
	if (
		isFiniteNonNegative(secureConnectionStart) &&
		secureConnectionStart > 0 &&
		isFiniteNonNegative(connectEnd) &&
		connectEnd >= secureConnectionStart
	)
		attributes[`${PREFIX}tls_ms`] = bounded(
			connectEnd - secureConnectionStart,
			MAX_AGGREGATE_DURATION_MS,
		);
	addTimingDifference(
		attributes,
		"ttfb_ms",
		entry,
		"requestStart",
		"responseStart",
	);
	addByteField(attributes, "response_transfer_bytes", entry, "transferSize");
	addByteField(attributes, "response_encoded_bytes", entry, "encodedBodySize");
	addByteField(attributes, "response_decoded_bytes", entry, "decodedBodySize");
}

function addDeviceContext(
	attributes: RepositoryOpenProfileAttributes,
	navigatorApi: RepositoryOpenProfileNavigator | undefined,
): void {
	if (!navigatorApi) return;
	try {
		const hardwareConcurrency = navigatorApi.hardwareConcurrency;
		if (
			typeof hardwareConcurrency === "number" &&
			Number.isFinite(hardwareConcurrency) &&
			hardwareConcurrency > 0
		)
			attributes[`${PREFIX}hardware_concurrency_bucket`] =
				hardwareConcurrency <= 1
					? "1"
					: hardwareConcurrency <= 2
						? "2"
						: hardwareConcurrency <= 4
							? "4"
							: hardwareConcurrency <= 8
								? "8"
								: "16_plus";
		const deviceMemory = navigatorApi.deviceMemory;
		if (
			typeof deviceMemory === "number" &&
			Number.isFinite(deviceMemory) &&
			deviceMemory > 0
		)
			attributes[`${PREFIX}device_memory_gb_bucket`] =
				deviceMemory <= 0.5
					? "0.5_or_less"
					: deviceMemory <= 1
						? "1"
						: deviceMemory <= 2
							? "2"
							: deviceMemory <= 4
								? "4"
								: "8_plus";
		const effectiveType = navigatorApi.connection?.effectiveType;
		if (
			effectiveType === "slow-2g" ||
			effectiveType === "2g" ||
			effectiveType === "3g" ||
			effectiveType === "4g"
		)
			attributes[`${PREFIX}network_effective_type`] = effectiveType;
		const browser = browserContext(navigatorApi.userAgent);
		if (browser) {
			attributes[`${PREFIX}browser_family`] = browser.family;
			if (browser.major !== undefined)
				attributes[`${PREFIX}browser_major`] = browser.major;
		}
	} catch {
		// Browser device context is optional and can be hidden by privacy settings.
	}
}

function browserContext(userAgent: unknown):
	| {
			family: "chrome" | "edge" | "firefox" | "safari" | "other";
			major?: number;
	  }
	| undefined {
	if (typeof userAgent !== "string") return undefined;
	const boundedUserAgent = userAgent.slice(0, 1_024);
	const versions: readonly [
		"edge" | "chrome" | "firefox" | "safari",
		RegExp,
	][] = [
		["edge", /(?:EdgA|EdgiOS|Edg|Edge)\/(\d+)/i],
		["chrome", /(?:Chrome|CriOS)\/(\d+)/i],
		["firefox", /(?:Firefox|FxiOS)\/(\d+)/i],
		["safari", /Version\/(\d+)(?=[.;\s])/i],
	];
	for (const [family, pattern] of versions) {
		const match = pattern.exec(boundedUserAgent);
		if (!match || (family === "safari" && !/Safari\//i.test(boundedUserAgent)))
			continue;
		const major = Number(match[1]);
		return {
			family,
			...(Number.isInteger(major) && major >= 1 && major <= 1_000
				? { major }
				: {}),
		};
	}
	return { family: "other" };
}

function addResourceAggregates(
	attributes: RepositoryOpenProfileAttributes,
	records: readonly ResourceRecord[],
	startTime: number,
	endTime: number,
	truncated: boolean,
): void {
	const aggregates = new Map<ResourceCategory, ResourceAggregate>(
		RESOURCE_CATEGORIES.map((category) => [
			category,
			{ count: 0, durationMs: 0, transferBytes: 0 },
		]),
	);
	for (const record of records) {
		const overlap = bounded(
			Math.min(record.responseEnd, endTime) -
				Math.max(record.startTime, startTime),
			MAX_AGGREGATE_DURATION_MS,
		);
		if (overlap <= 0) continue;
		const aggregate = aggregates.get(record.category)!;
		aggregate.count = Math.min(aggregate.count + 1, MAX_RESOURCE_RECORDS);
		aggregate.durationMs = bounded(
			aggregate.durationMs + overlap,
			MAX_AGGREGATE_DURATION_MS,
		);
		if (record.responseEnd <= endTime && record.transferSize !== undefined)
			aggregate.transferBytes = bounded(
				aggregate.transferBytes + record.transferSize,
				MAX_AGGREGATE_BYTES,
			);
	}
	for (const category of RESOURCE_CATEGORIES) {
		const aggregate = aggregates.get(category)!;
		const categoryPrefix = `${PREFIX}resources.${category}.`;
		attributes[`${categoryPrefix}count`] = aggregate.count;
		attributes[`${categoryPrefix}duration_ms`] = round(aggregate.durationMs);
		attributes[`${categoryPrefix}transfer_bytes`] = aggregate.transferBytes;
	}
	attributes[`${PREFIX}resources.truncated`] = truncated;
}

function addLongTaskAggregates(
	attributes: RepositoryOpenProfileAttributes,
	records: readonly LongTaskRecord[],
	startTime: number,
	endTime: number,
	truncated: boolean,
): void {
	let count = 0;
	let totalMs = 0;
	let maxMs = 0;
	for (const record of records) {
		const overlap = bounded(
			Math.min(record.startTime + record.duration, endTime) -
				Math.max(record.startTime, startTime),
			MAX_AGGREGATE_DURATION_MS,
		);
		if (overlap <= 0) continue;
		count = Math.min(count + 1, MAX_LONG_TASK_RECORDS);
		totalMs = bounded(totalMs + overlap, MAX_AGGREGATE_DURATION_MS);
		maxMs = Math.max(maxMs, overlap);
	}
	attributes[`${PREFIX}longtask.count`] = count;
	attributes[`${PREFIX}longtask.total_ms`] = round(totalMs);
	attributes[`${PREFIX}longtask.max_ms`] = round(maxMs);
	attributes[`${PREFIX}longtask.truncated`] = truncated;
}

function resourceRecord(
	entry: unknown,
	origin: string | undefined,
): ResourceRecord | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	try {
		const fields = entry as Record<string, unknown>;
		const startTime = fields.startTime;
		const duration = fields.duration;
		const responseEnd =
			fields.responseEnd ??
			(typeof startTime === "number" && typeof duration === "number"
				? startTime + duration
				: undefined);
		if (
			!isFiniteNonNegative(startTime) ||
			!isFiniteNonNegative(duration) ||
			!isFiniteNonNegative(responseEnd)
		)
			return undefined;
		const category = classifyResource(
			fields.name,
			fields.initiatorType,
			origin,
		);
		if (!category) return undefined;
		const transferSize = fields.transferSize;
		return {
			category,
			startTime,
			responseEnd,
			...(isFiniteNonNegative(transferSize) ? { transferSize } : {}),
		};
	} catch {
		return undefined;
	}
}

function classifyResource(
	name: unknown,
	initiatorType: unknown,
	origin: string | undefined,
): ResourceCategory | undefined {
	if (typeof name !== "string" || !origin) return "other";
	try {
		const base = new URL(origin);
		const url = new URL(name, base);
		if (url.origin !== base.origin) return "other";
		const pathname = url.pathname.toLowerCase();
		if (/^\/api\/telemetry(?:\/|$)/.test(pathname)) return undefined;
		if (pathname.endsWith(".wasm")) return "wasm";
		if (/^\/(?:api\/)?lix\/v[0-9]+(?:\/|$)/.test(pathname)) return "lix";
		if (/^\/(?:api|auth\/v[0-9]+|functions\/v[0-9]+)(?:\/|$)/.test(pathname))
			return "api";
		if (
			pathname.endsWith(".js") ||
			pathname.endsWith(".mjs") ||
			initiatorType === "script"
		)
			return "first_party_js";
		return "other";
	} catch {
		return "other";
	}
}

function longTaskRecord(entry: unknown): LongTaskRecord | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	try {
		const fields = entry as Record<string, unknown>;
		const startTime = fields.startTime;
		const duration = fields.duration;
		return isFiniteNonNegative(startTime) && isFiniteNonNegative(duration)
			? { startTime, duration: bounded(duration, MAX_AGGREGATE_DURATION_MS) }
			: undefined;
	} catch {
		return undefined;
	}
}

function addTimingDifference(
	attributes: RepositoryOpenProfileAttributes,
	key: string,
	entry: Record<string, unknown>,
	startKey: string,
	endKey: string,
): void {
	const start = safeField(entry, startKey);
	const end = safeField(entry, endKey);
	if (isFiniteNonNegative(start) && isFiniteNonNegative(end) && end >= start)
		attributes[`${PREFIX}${key}`] = round(
			bounded(end - start, MAX_AGGREGATE_DURATION_MS),
		);
}

function addByteField(
	attributes: RepositoryOpenProfileAttributes,
	key: string,
	entry: Record<string, unknown>,
	field: string,
): void {
	const value = safeField(entry, field);
	if (isFiniteNonNegative(value))
		attributes[`${PREFIX}${key}`] = Math.min(
			Math.floor(value),
			MAX_AGGREGATE_BYTES,
		);
}

function safeField(entry: Record<string, unknown>, key: string): unknown {
	try {
		return entry[key];
	} catch {
		return undefined;
	}
}

function safeDependency<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

function browserPerformance(): RepositoryOpenPerformance | undefined {
	return typeof performance === "undefined" ? undefined : performance;
}

function browserPerformanceObserver():
	| RepositoryOpenProfileObserverConstructor
	| undefined {
	return typeof PerformanceObserver === "undefined"
		? undefined
		: (PerformanceObserver as unknown as RepositoryOpenProfileObserverConstructor);
}

function browserNavigator(): RepositoryOpenProfileNavigator | undefined {
	return typeof navigator === "undefined"
		? undefined
		: (navigator as unknown as RepositoryOpenProfileNavigator);
}

function browserOrigin(): string | undefined {
	return typeof location === "undefined" ? undefined : location.origin;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function bounded(value: number, max: number): number {
	return Math.min(Math.max(value, 0), max);
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
