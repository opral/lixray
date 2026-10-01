import assert from "node:assert/strict";
import test from "node:test";
import {
	createRepositoryOpenProfile,
	type RepositoryOpenProfileEntryList,
	type RepositoryOpenProfileObserver,
	type RepositoryOpenProfileObserverConstructor,
} from "./repository-open-profile.ts";

type Entry = Record<string, unknown>;

class FakePerformanceObserver implements RepositoryOpenProfileObserver {
	static instances: FakePerformanceObserver[] = [];
	static rejectTypes = new Set<string>();

	callback: (list: RepositoryOpenProfileEntryList) => void;
	type = "";
	buffered = false;
	disconnected = false;
	pending: unknown[] = [];

	constructor(callback: (list: RepositoryOpenProfileEntryList) => void) {
		this.callback = callback;
		FakePerformanceObserver.instances.push(this);
	}

	observe(options: { type: string; buffered: boolean }): void {
		this.type = options.type;
		this.buffered = options.buffered;
		if (FakePerformanceObserver.rejectTypes.has(options.type))
			throw new Error("observer unsupported");
	}

	disconnect(): void {
		this.disconnected = true;
	}

	takeRecords(): readonly unknown[] {
		const records = this.pending;
		this.pending = [];
		return records;
	}

	emit(entries: readonly unknown[]): void {
		this.callback({ getEntries: () => entries });
	}
}

const observerConstructor =
	FakePerformanceObserver as unknown as RepositoryOpenProfileObserverConstructor;

function profileAttributes(
	profile: {
		finish(endTime: number): Record<string, string | number | boolean>;
	},
	endTime: number,
): Record<string, string | number | boolean> {
	return profile.finish(endTime);
}

void test("collects bounded navigation, interval resources, long tasks, and coarse device context", () => {
	FakePerformanceObserver.instances = [];
	FakePerformanceObserver.rejectTypes = new Set();
	const navigation: Entry = {
		type: "navigate",
		domainLookupStart: 1,
		domainLookupEnd: 4,
		connectStart: 4,
		connectEnd: 14,
		secureConnectionStart: 9,
		requestStart: 14,
		responseStart: 40,
		transferSize: 500,
		encodedBodySize: 300,
		decodedBodySize: 1200,
	};
	const profile = createRepositoryOpenProfile(100, {
		performance: {
			getEntriesByType(type) {
				return type === "navigation" ? [navigation] : [];
			},
		},
		PerformanceObserver: observerConstructor,
		origin: "https://app.example",
		navigator: {
			hardwareConcurrency: 6,
			deviceMemory: 3,
			connection: { effectiveType: "3g" },
		},
		pagePersisted: true,
	});
	const [resources, longTasks] = FakePerformanceObserver.instances;
	assert.ok(resources);
	assert.ok(longTasks);
	assert.equal(resources.type, "resource");
	assert.equal(resources.buffered, true);
	assert.equal(longTasks.type, "longtask");
	assert.equal(longTasks.buffered, true);

	resources.emit([
		{
			name: "https://app.example/assets/lix_js_sdk_bg.wasm?private=wasm-secret",
			initiatorType: "fetch",
			startTime: 90,
			duration: 30,
			responseEnd: 120,
			transferSize: 1000,
		},
		{
			name: "https://app.example/api/repositories/private-id?token=api-secret",
			initiatorType: "fetch",
			startTime: 100,
			duration: 60,
			responseEnd: 160,
			transferSize: 500,
		},
		{
			name: "https://app.example/lix/v1/private-id/query?sql=private-sql",
			initiatorType: "fetch",
			startTime: 150,
			duration: 100,
			responseEnd: 250,
			transferSize: 700,
		},
		{
			name: "https://app.example/assets/repository-home.js?token=js-secret",
			initiatorType: "script",
			startTime: 175,
			duration: 15,
			responseEnd: 190,
			transferSize: 200,
		},
		{
			name: "https://cdn.example/analytics.js?token=third-party-secret",
			initiatorType: "script",
			startTime: 120,
			duration: 10,
			responseEnd: 130,
			transferSize: 50,
		},
		{
			name: "https://app.example/api/after-open",
			initiatorType: "fetch",
			startTime: 210,
			duration: 5,
			responseEnd: 215,
			transferSize: 50,
		},
	]);
	longTasks.emit([
		{ name: "self", startTime: 90, duration: 30, attribution: "secret-url" },
		{ name: "self", startTime: 150, duration: 100 },
		{ name: "self", startTime: 30, duration: 50 },
		{ name: "self", startTime: 205, duration: 10 },
	]);
	longTasks.pending.push({
		startTime: 198,
		duration: 10,
		attribution: "secret-url",
	});

	const attributes = profileAttributes(profile, 200);
	assert.equal(
		attributes["lixray.repository.open.profile.interval_valid"],
		true,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.navigation_timing_supported"],
		true,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resource_timing_supported"],
		true,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask_supported"],
		true,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.navigation_type"],
		undefined,
	);
	assert.equal(attributes["lixray.repository.open.profile.dns_ms"], undefined);
	assert.equal(
		attributes["lixray.repository.open.profile.connect_ms"],
		undefined,
	);
	assert.equal(attributes["lixray.repository.open.profile.tls_ms"], undefined);
	assert.equal(attributes["lixray.repository.open.profile.ttfb_ms"], undefined);
	assert.equal(
		attributes["lixray.repository.open.profile.response_transfer_bytes"],
		undefined,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.response_encoded_bytes"],
		undefined,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.response_decoded_bytes"],
		undefined,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.wasm.count"],
		1,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.wasm.duration_ms"],
		20,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.wasm.transfer_bytes"],
		1000,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.api.count"],
		1,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.api.duration_ms"],
		60,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.api.transfer_bytes"],
		500,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.lix.count"],
		1,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.lix.duration_ms"],
		50,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.lix.transfer_bytes"],
		0,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.first_party_js.count"],
		1,
	);
	assert.equal(
		attributes[
			"lixray.repository.open.profile.resources.first_party_js.duration_ms"
		],
		15,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.other.count"],
		1,
	);
	assert.equal(attributes["lixray.repository.open.profile.longtask.count"], 3);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask.total_ms"],
		72,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask.max_ms"],
		50,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.hardware_concurrency_bucket"],
		"8",
	);
	assert.equal(
		attributes["lixray.repository.open.profile.device_memory_gb_bucket"],
		"4",
	);
	assert.equal(
		attributes["lixray.repository.open.profile.network_effective_type"],
		"3g",
	);
	assert.equal(
		attributes["lixray.repository.open.profile.page_persisted"],
		true,
	);

	const serialized = JSON.stringify(attributes);
	assert.doesNotMatch(
		serialized,
		/wasm-secret|api-secret|private-id|private-sql|js-secret|third-party-secret|secret-url|analytics\.js|repository-home\.js/,
	);
	assert.equal(resources.disconnected, true);
	assert.equal(longTasks.disconnected, true);
	const snapshot = profile.finish(300);
	assert.deepEqual(snapshot, attributes);
	resources.emit([
		{ name: "https://app.example/private.js", startTime: 120, duration: 2 },
	]);
	assert.deepEqual(profile.finish(300), attributes);
});

void test("bounds buffered observer records and reports truncation", () => {
	FakePerformanceObserver.instances = [];
	FakePerformanceObserver.rejectTypes = new Set();
	const profile = createRepositoryOpenProfile(10, {
		performance: { getEntriesByType: () => [] },
		PerformanceObserver: observerConstructor,
		origin: "https://app.example",
	});
	const [resources, longTasks] = FakePerformanceObserver.instances;
	assert.ok(resources);
	assert.ok(longTasks);
	resources.emit(
		Array.from({ length: 1_001 }, (_, index) => ({
			name: `https://app.example/assets/${index}.js`,
			initiatorType: "script",
			startTime: 10,
			duration: 1,
			responseEnd: 11,
			transferSize: 1,
		})),
	);
	longTasks.emit(
		Array.from({ length: 1_001 }, (_, index) => ({
			name: "self",
			startTime: 10 + index / 1_000,
			duration: 1,
		})),
	);
	const attributes = profile.finish(20);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.first_party_js.count"],
		1_000,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.truncated"],
		true,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask.count"],
		1_000,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask.truncated"],
		true,
	);
});

void test("includes document navigation timing only for the initial open", () => {
	const navigation: Entry = {
		type: "navigate",
		domainLookupStart: 1,
		domainLookupEnd: 4,
		connectStart: 4,
		connectEnd: 14,
		secureConnectionStart: 9,
		requestStart: 14,
		responseStart: 40,
		transferSize: 500,
		encodedBodySize: 300,
		decodedBodySize: 1200,
	};
	const profile = createRepositoryOpenProfile(0, {
		performance: { getEntriesByType: () => [navigation] },
		PerformanceObserver: null,
	});
	const attributes = profile.finish(20);
	assert.equal(
		attributes["lixray.repository.open.profile.navigation_timing_supported"],
		true,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.navigation_type"],
		"navigate",
	);
	assert.equal(attributes["lixray.repository.open.profile.dns_ms"], 3);
	assert.equal(attributes["lixray.repository.open.profile.connect_ms"], 10);
	assert.equal(attributes["lixray.repository.open.profile.tls_ms"], 5);
	assert.equal(attributes["lixray.repository.open.profile.ttfb_ms"], 26);
	assert.equal(
		attributes["lixray.repository.open.profile.response_transfer_bytes"],
		500,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.response_encoded_bytes"],
		300,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.response_decoded_bytes"],
		1200,
	);
});

void test("historic resources do not consume the in-window record limit", () => {
	FakePerformanceObserver.instances = [];
	FakePerformanceObserver.rejectTypes = new Set();
	const profile = createRepositoryOpenProfile(100, {
		performance: { getEntriesByType: () => [] },
		PerformanceObserver: observerConstructor,
		origin: "https://app.example",
	});
	const [resources] = FakePerformanceObserver.instances;
	assert.ok(resources);
	resources.emit([
		...Array.from({ length: 1_001 }, (_, index) => ({
			name: `https://app.example/assets/old-${index}.js`,
			initiatorType: "script",
			startTime: 1,
			duration: 1,
			responseEnd: 2,
			transferSize: 1,
		})),
		...Array.from({ length: 1_000 }, (_, index) => ({
			name: `https://app.example/assets/current-${index}.js`,
			initiatorType: "script",
			startTime: 100,
			duration: 1,
			responseEnd: 101,
			transferSize: 1,
		})),
	]);
	const [, longTasks] = FakePerformanceObserver.instances;
	assert.ok(longTasks);
	longTasks.emit([
		...Array.from({ length: 1_001 }, () => ({
			name: "self",
			startTime: 1,
			duration: 1,
		})),
		...Array.from({ length: 1_000 }, () => ({
			name: "self",
			startTime: 100,
			duration: 1,
		})),
	]);
	const attributes = profile.finish(200);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.first_party_js.count"],
		1_000,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.truncated"],
		false,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask.count"],
		1_000,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask.truncated"],
		false,
	);
});

void test("marks unavailable capabilities and tolerates malformed browser surfaces", () => {
	FakePerformanceObserver.instances = [];
	FakePerformanceObserver.rejectTypes = new Set(["resource", "longtask"]);
	const navigatorWithThrowingGetter = Object.defineProperty(
		{},
		"hardwareConcurrency",
		{
			get: () => {
				throw new Error("private device detail");
			},
		},
	);
	const profile = createRepositoryOpenProfile(Number.NaN, {
		performance: {
			getEntriesByType() {
				throw new Error("private navigation detail");
			},
		},
		PerformanceObserver: observerConstructor,
		origin: "https://[invalid",
		navigator: navigatorWithThrowingGetter,
		pagePersisted: true,
	});
	let attributes: Record<string, string | number | boolean>;
	assert.doesNotThrow(() => {
		attributes = profile.finish(Number.NaN);
	});
	assert.equal(
		attributes!["lixray.repository.open.profile.interval_valid"],
		false,
	);
	assert.equal(
		attributes!["lixray.repository.open.profile.navigation_timing_supported"],
		false,
	);
	assert.equal(
		attributes!["lixray.repository.open.profile.resource_timing_supported"],
		false,
	);
	assert.equal(
		attributes!["lixray.repository.open.profile.longtask_supported"],
		false,
	);
	assert.equal(
		attributes!["lixray.repository.open.profile.page_persisted"],
		true,
	);
	assert.equal(
		Object.keys(attributes!).some((key) => key.includes("private")),
		false,
	);
	assert.equal(JSON.stringify(attributes!).includes("private"), false);
	assert.equal(
		Object.keys(attributes!).some((key) => key.includes("resources.")),
		false,
	);
	assert.equal(
		Object.keys(attributes!).some((key) => key.includes("longtask.")),
		false,
	);
	assert.equal(FakePerformanceObserver.instances.length, 2);
	assert.ok(
		FakePerformanceObserver.instances.every(
			(observer) => observer.disconnected,
		),
	);
});

void test("explicitly disables observers when the platform has no PerformanceObserver", () => {
	const profile = createRepositoryOpenProfile(0, {
		performance: { getEntriesByType: () => [] },
		PerformanceObserver: null,
		navigator: { hardwareConcurrency: Infinity, deviceMemory: Infinity },
	});
	const attributes = profile.finish(1);
	assert.equal(
		attributes["lixray.repository.open.profile.resource_timing_supported"],
		false,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.longtask_supported"],
		false,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.hardware_concurrency_bucket"],
		undefined,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.device_memory_gb_bucket"],
		undefined,
	);
});

void test("captures only bounded browser family and major version", () => {
	const cases = [
		["Mozilla/5.0 Chrome/127.0.0.0 Safari/537.36", "chrome", 127],
		["Mozilla/5.0 Edg/130.0.0.0", "edge", 130],
		["Mozilla/5.0 FxiOS/128.0 Mobile", "firefox", 128],
		["Mozilla/5.0 Version/17.5 Mobile Safari/604.1", "safari", 17],
		["Mozilla/5.0 UnknownBrowser/2200", "other", undefined],
		["Mozilla/5.0 Edg/1001.0", "edge", undefined],
	] as const;
	for (const [userAgent, family, major] of cases) {
		const attributes = createRepositoryOpenProfile(1, {
			PerformanceObserver: null,
			navigator: { userAgent },
		}).finish(2);
		assert.equal(
			attributes["lixray.repository.open.profile.browser_family"],
			family,
		);
		assert.equal(
			attributes["lixray.repository.open.profile.browser_major"],
			major,
		);
		assert.equal(JSON.stringify(attributes).includes(userAgent), false);
	}
});

void test("does not measure the application telemetry export requests", () => {
	FakePerformanceObserver.instances = [];
	FakePerformanceObserver.rejectTypes = new Set();
	const profile = createRepositoryOpenProfile(10, {
		performance: { getEntriesByType: () => [] },
		PerformanceObserver: observerConstructor,
		origin: "https://app.example",
	});
	const [resources] = FakePerformanceObserver.instances;
	assert.ok(resources);
	resources.emit([
		{
			name: "https://app.example/api/telemetry/browser/otlp/v1/traces?secret=private",
			initiatorType: "fetch",
			startTime: 10,
			duration: 40,
			responseEnd: 50,
			transferSize: 400,
		},
		{
			name: "https://app.example/api/telemetry/product?secret=private",
			initiatorType: "fetch",
			startTime: 50,
			duration: 20,
			responseEnd: 70,
			transferSize: 200,
		},
		{
			name: "https://app.example/api/repositories",
			initiatorType: "fetch",
			startTime: 70,
			duration: 10,
			responseEnd: 80,
			transferSize: 100,
		},
	]);
	const attributes = profile.finish(100);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.api.count"],
		1,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.api.duration_ms"],
		10,
	);
	assert.equal(
		attributes["lixray.repository.open.profile.resources.api.transfer_bytes"],
		100,
	);
	assert.equal(JSON.stringify(attributes).includes("private"), false);
});
