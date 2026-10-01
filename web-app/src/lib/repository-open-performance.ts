import {
	context,
	trace,
	ROOT_CONTEXT,
	SpanStatusCode,
	type Tracer,
} from "@opentelemetry/api";
import { tracer } from "../telemetry.ts";
import type { LixOpenProgress, LixOpenReport } from "@lix-js/sdk";
import { createRepositoryOpenProfile } from "./repository-open-profile.ts";

export interface RepositoryOpeningRecorder {
	opened(
		report: LixOpenReport | undefined,
		mode: "partial_replica" | "remote",
	): void;
	reused(
		acquisition: "joined" | "reused",
		mode: "partial_replica" | "remote",
	): void;
	engineAttempt(): void;
	retry(delayMs: number): void;
	replacement(): void;
	progress(progress: LixOpenProgress): void;
	request(): (status?: number) => void;
}

export const REPOSITORY_OPEN_MARKS = {
	start: "lixray:repository-open:start",
	replicaIdentified: "lixray:repository-open:replica-identified",
	lixOpened: "lixray:repository-open:lix-opened",
	branchReady: "lixray:repository-open:branch-ready",
	sessionReady: "lixray:repository-open:session-ready",
	atelierReady: "lixray:repository-open:atelier-ready",
	treeReady: "lixray:repository-open:tree-ready",
} as const;
const phases = [
	"bootstrap",
	"auth",
	"access",
	"replica",
	"engine",
	"branch",
	"session",
	"atelier",
	"initial_view",
	"paint",
] as const;
type Phase = (typeof phases)[number];
type Outcome = "usable" | "failed" | "cancelled" | "superseded" | "timeout";

/** One route attempt; phase spans are ended together so pre-auth work is not exported before access is known. */
export function createRepositoryOpenTrace(
	tracer: Tracer,
	now = () => performance.now(),
	origin = () => performance.timeOrigin,
	paint = {
		request: (callback: FrameRequestCallback) =>
			requestAnimationFrame(callback),
		cancel: (id: number) => cancelAnimationFrame(id),
	},
	profile = createRepositoryOpenProfile,
) {
	let active:
		| {
				key: string;
				repositoryId?: string;
				span: ReturnType<Tracer["startSpan"]>;
				context: ReturnType<typeof trace.setSpan>;
				start: number;
				phase: Phase;
				phaseStart: number;
				phases: { name: Phase; start: number; end: number }[];
				timer: ReturnType<typeof setTimeout>;
				ended: boolean;
				outcome?: Outcome;
				mounted: boolean;
				frames: number[];
				visibilityChanged: () => void;
				abortCleanup: () => void;
				background: boolean;
				profile: ReturnType<typeof createRepositoryOpenProfile>;
				counts: Record<string, number>;
				native: Map<string, { phase: string; start: number }>;
		  }
		| undefined;
	const timestamp = (ms: number) => origin() + ms;
	const closeNativeStep = (
		attempt: NonNullable<typeof active>,
		scope: string,
		end: number,
	) => {
		const step = attempt.native.get(scope);
		if (!step) return;
		const child = tracer.startSpan(
			`lixray.repository.open.native.${scope}.${step.phase}`,
			{
				startTime: timestamp(step.start),
				attributes: {
					"lix.id": attempt.repositoryId ?? "",
					"lixray.repository.open.native_scope": scope,
				},
			},
			attempt.context,
		);
		child.end(timestamp(end));
		const key = `native.${scope}.${step.phase}_ms`;
		attempt.counts[key] =
			(attempt.counts[key] ?? 0) + Math.max(0, end - step.start);
		attempt.native.delete(scope);
	};
	const finish = (outcome: Outcome) => {
		const attempt = active;
		if (!attempt || attempt.ended) return;
		attempt.ended = true;
		attempt.outcome = outcome;
		attempt.abortCleanup();
		clearTimeout(attempt.timer);
		for (const frame of attempt.frames) paint.cancel(frame);
		if (typeof document !== "undefined")
			document.removeEventListener(
				"visibilitychange",
				attempt.visibilityChanged,
			);
		attempt.span.setAttribute(
			"lixray.repository.open.visibility",
			attempt.background ? "background" : "foreground",
		);
		const end = now();
		for (const [key, value] of Object.entries(attempt.profile.finish(end)))
			attempt.span.setAttribute(key, value);
		for (const scope of attempt.native.keys())
			closeNativeStep(attempt, scope, end);
		for (const [key, value] of Object.entries(attempt.counts))
			attempt.span.setAttribute(`lixray.repository.open.${key}`, value);
		attempt.span.setAttribute(
			"lixray.repository.open.terminal_phase",
			attempt.phase,
		);
		const bottleneck = [
			...attempt.phases,
			{ name: attempt.phase, start: attempt.phaseStart, end },
		].reduce((largest, phase) =>
			phase.end - phase.start > largest.end - largest.start ? phase : largest,
		);
		attempt.span.setAttribute(
			"lixray.repository.open.longest_phase",
			bottleneck.name,
		);
		attempt.span.setAttribute(
			"lixray.repository.open.longest_phase_ms",
			bottleneck.end - bottleneck.start,
		);
		attempt.phases.push({
			name: attempt.phase,
			start: attempt.phaseStart,
			end,
		});
		for (const phase of attempt.phases) {
			const child = tracer.startSpan(
				`lixray.repository.open.${phase.name}`,
				{
					startTime: timestamp(phase.start),
					attributes: {
						...(attempt.repositoryId ? { "lix.id": attempt.repositoryId } : {}),
						"lixray.repository.open.phase": phase.name,
					},
				},
				attempt.context,
			);
			child.end(timestamp(phase.end));
			attempt.span.setAttribute(
				`lixray.repository.open.${phase.name}_ms`,
				phase.end - phase.start,
			);
		}
		attempt.span.setAttribute(
			"lixray.repository.open.duration_ms",
			end - attempt.start,
		);
		attempt.span.setAttribute("lixray.repository.open.outcome", outcome);
		if (outcome === "failed" || outcome === "timeout") {
			attempt.span.setStatus({ code: SpanStatusCode.ERROR });
			attempt.span.setAttribute("error.type", `repository_open_${outcome}`);
		}
		attempt.span.end(timestamp(end));
	};
	const bindNavigation = (signal?: AbortSignal) => {
		const attempt = active;
		if (!attempt || attempt.mounted || attempt.ended) return;
		attempt.abortCleanup();
		if (!signal) return;
		const onAbort = () => {
			if (active === attempt) {
				finish("cancelled");
				active = undefined;
			}
		};
		attempt.abortCleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	};
	return {
		begin(
			key: string,
			start = now(),
			entry: "navigation" | "client_navigation" | "retry" = "client_navigation",
			navigationSignal?: AbortSignal,
		) {
			if (
				active?.key === key &&
				(!active.ended || active.outcome === "usable")
			) {
				bindNavigation(navigationSignal);
				return;
			}
			finish("superseded");
			const span = tracer.startSpan(
				"lixray.repository.open",
				{
					startTime: timestamp(start),
					attributes: {
						"lixray.repository.open.entry": entry,
						"lixray.repository.open.ready_definition":
							"initial_view_after_paint",
						"lixray.repository.open.profile_version": 1,
						"lixray.repository.open.replica_state": "unknown",
					},
				},
				ROOT_CONTEXT,
			);
			const visibilityChanged = () => {
				if (active && typeof document !== "undefined" && document.hidden)
					active.background = true;
			};
			active = {
				key,
				span,
				context: trace.setSpan(ROOT_CONTEXT, span),
				start,
				phase: "bootstrap",
				phaseStart: start,
				phases: [],
				ended: false,
				mounted: false,
				frames: [],
				abortCleanup: () => {},
				visibilityChanged,
				background: typeof document !== "undefined" && document.hidden,
				profile: profile(start),
				counts: {
					engine_attempts: 0,
					retry_count: 0,
					retry_backoff_scheduled_ms: 0,
					replacement_count: 0,
					rpc_count: 0,
					rpc_response_headers_pending: 0,
					rpc_failed: 0,
					rpc_response_headers_total_ms: 0,
					rpc_response_headers_max_ms: 0,
				},
				native: new Map(),
				timer: setTimeout(() => finish("timeout"), 120_000),
			};
			if (typeof document !== "undefined")
				document.addEventListener("visibilitychange", visibilityChanged);
			bindNavigation(navigationSignal);
		},
		mount() {
			if (active) active.mounted = true;
			active?.abortCleanup();
			this.phase("auth");
		},
		attempt(repositoryId?: string) {
			if (active?.ended) {
				const key = active.key;
				active = undefined;
				this.begin(key, now(), "retry");
			}
			this.phase("replica", repositoryId);
		},
		phase(next: Phase, repositoryId?: string) {
			if (
				!active ||
				active.ended ||
				(repositoryId &&
					active.repositoryId &&
					active.repositoryId !== repositoryId)
			)
				return;
			if (repositoryId) {
				active.repositoryId = repositoryId;
				active.span.setAttribute("lix.id", repositoryId);
			}
			if (phases.indexOf(next) <= phases.indexOf(active.phase)) return;
			const end = now();
			active.phases.push({ name: active.phase, start: active.phaseStart, end });
			active.phase = next;
			active.phaseStart = end;
		},
		finish,
		cancel(key: string) {
			if (active?.key === key) {
				finish("cancelled");
				active = undefined;
			}
		},
		run<T>(operation: () => T): T {
			return active && !active.ended
				? context.with(active.context, operation)
				: operation();
		},
		parentContext() {
			return active && !active.ended ? active.context : undefined;
		},
		recorder(repositoryId: string): RepositoryOpeningRecorder | undefined {
			const attempt = active;
			if (
				!attempt ||
				attempt.ended ||
				(attempt.repositoryId && attempt.repositoryId !== repositoryId)
			)
				return undefined;
			attempt.repositoryId = repositoryId;
			attempt.span.setAttribute("lix.id", repositoryId);
			const current = () => active === attempt && !attempt.ended;
			const increment = (key: string, value = 1) => {
				if (current()) attempt.counts[key] = (attempt.counts[key] ?? 0) + value;
			};
			return {
				opened(report, mode) {
					if (!current()) return;
					attempt.span.setAttribute(
						"lixray.repository.open.replica_mode",
						mode,
					);
					attempt.span.setAttribute(
						"lixray.repository.open.replica_state",
						mode === "remote"
							? "remote"
							: report
								? report.initialized
									? "fresh"
									: "cached"
								: "unknown",
					);
					if (report?.hostProfile) {
						for (const [key, value] of Object.entries(
							hostProfileAttributes(report.hostProfile),
						))
							attempt.span.setAttribute(
								`lixray.repository.open.host.${key}`,
								value,
							);
					}
					if (!report || mode === "remote") return;
					attempt.span.setAttribute(
						"lixray.repository.open.initialized_this_open",
						report.initialized,
					);
					attempt.span.setAttribute(
						"lixray.repository.open.storage_format",
						report.format,
					);
					attempt.span.setAttribute(
						"lixray.repository.open.local_migration_count",
						report.migrations.filter((m) => m.scope === "local").length,
					);
					attempt.span.setAttribute(
						"lixray.repository.open.authority_migration_count",
						report.migrations.filter((m) => m.scope === "authority").length,
					);
				},
				reused(acquisition, mode) {
					// Strict Mode can acquire multiple handles for one route. The route
					// that actually created the engine keeps its native lifecycle facts.
					if (current() && attempt.counts.engine_attempts === 0) {
						attempt.span.setAttribute(
							"lixray.repository.open.session_acquisition",
							acquisition,
						);
						attempt.span.setAttribute(
							"lixray.repository.open.replica_state",
							acquisition === "joined" ? "joined_open" : "reused_session",
						);
						attempt.span.setAttribute(
							"lixray.repository.open.replica_mode",
							mode,
						);
					}
				},
				engineAttempt() {
					increment("engine_attempts");
					if (current())
						attempt.span.setAttribute(
							"lixray.repository.open.session_acquisition",
							"created",
						);
				},
				retry(delayMs) {
					if (!current()) return;
					for (const scope of attempt.native.keys())
						closeNativeStep(attempt, scope, now());
					increment("retry_count");
					increment("retry_backoff_scheduled_ms", delayMs);
				},
				replacement() {
					if (!current()) return;
					for (const scope of attempt.native.keys())
						closeNativeStep(attempt, scope, now());
					increment("replacement_count");
				},
				progress(progress) {
					if (
						!current() ||
						!["local", "authority"].includes(progress.scope) ||
						![
							"inspecting",
							"migrating",
							"validating",
							"opening",
							"complete",
						].includes(progress.phase)
					)
						return;
					const end = now();
					const previous = attempt.native.get(progress.scope);
					if (previous?.phase === progress.phase) return;
					closeNativeStep(attempt, progress.scope, end);
					if (progress.phase === "complete")
						attempt.native.delete(progress.scope);
					else
						attempt.native.set(progress.scope, {
							phase: progress.phase,
							start: end,
						});
				},
				request() {
					if (!current()) return () => {};
					const start = now();
					increment("rpc_count");
					increment("rpc_response_headers_pending");
					let finished = false;
					return (status) => {
						if (!current() || finished) return;
						finished = true;
						const elapsed = now() - start;
						increment("rpc_response_headers_pending", -1);
						increment("rpc_response_headers_total_ms", elapsed);
						attempt.counts.rpc_response_headers_max_ms = Math.max(
							attempt.counts.rpc_response_headers_max_ms!,
							elapsed,
						);
						if (status === undefined || status >= 400) increment("rpc_failed");
					};
				},
			};
		},
		usable(repositoryId: string) {
			const attempt = active;
			if (
				!attempt ||
				attempt.ended ||
				attempt.phase === "paint" ||
				attempt.repositoryId !== repositoryId ||
				phases.indexOf(attempt.phase) < phases.indexOf("initial_view")
			)
				return;
			this.phase("paint", repositoryId);
			// A React effect confirms the data committed. Two animation frames allow that
			// committed view to paint before reporting usability, without waiting for sync.
			attempt.frames.push(
				paint.request(() => {
					if (active !== attempt || attempt.ended) return;
					attempt.frames.push(
						paint.request(() => {
							if (active === attempt && !attempt.ended) finish("usable");
						}),
					);
				}),
			);
		},
	};
}
export const repositoryOpenTrace = createRepositoryOpenTrace(tracer);
let mountedRoutes = 0;
let initialNavigationSeen = false;
export function retainRepositoryOpenRoute(key: string): () => void {
	// Hydration may reuse a loaded route match without running beforeLoad again.
	const separator = key.indexOf("/");
	beginRepositoryOpenRoute(key.slice(0, separator), key.slice(separator + 1));
	mountedRoutes++;
	repositoryOpenTrace.mount();
	return () => {
		mountedRoutes--;
		queueMicrotask(() => {
			if (mountedRoutes === 0) repositoryOpenTrace.cancel(key);
		});
	};
}
export function beginRepositoryOpenRoute(
	namespace: string,
	repository: string,
	signal?: AbortSignal,
): void {
	if (typeof window === "undefined") return;
	const key = `${namespace}/${repository}`;
	const navigation = performance.getEntriesByType("navigation")[0];
	const initial =
		!initialNavigationSeen &&
		navigation &&
		new URL(navigation.name).pathname.split("/").slice(1, 3).join("/") ===
			`@${key}`;
	initialNavigationSeen = true;
	repositoryOpenTrace.begin(
		key,
		initial ? 0 : performance.now(),
		initial ? "navigation" : "client_navigation",
		signal,
	);
}
export function resetRepositoryOpenPerformance(repositoryId?: string): void {
	if (typeof performance === "undefined") return;
	for (const mark of Object.values(REPOSITORY_OPEN_MARKS))
		performance.clearMarks(mark);
	performance.mark(REPOSITORY_OPEN_MARKS.start);
	repositoryOpenTrace.attempt(repositoryId);
}
export function markRepositoryOpenPerformance(
	mark: (typeof REPOSITORY_OPEN_MARKS)[keyof typeof REPOSITORY_OPEN_MARKS],
	repositoryId?: string,
): void {
	if (typeof performance === "undefined") return;
	performance.clearMarks(mark);
	performance.mark(mark);
	const next: Partial<Record<typeof mark, Phase>> = {
		[REPOSITORY_OPEN_MARKS.replicaIdentified]: "engine",
		[REPOSITORY_OPEN_MARKS.lixOpened]: "branch",
		[REPOSITORY_OPEN_MARKS.branchReady]: "session",
		[REPOSITORY_OPEN_MARKS.sessionReady]: "atelier",
		[REPOSITORY_OPEN_MARKS.atelierReady]: "initial_view",
	};
	if (next[mark]) repositoryOpenTrace.phase(next[mark]!, repositoryId);
	if (mark === REPOSITORY_OPEN_MARKS.treeReady && repositoryId)
		repositoryOpenTrace.usable(repositoryId);
}

/** Fixed schema: host timings never copy arbitrary SDK fields into telemetry. */
function hostProfileAttributes(
	profile: NonNullable<LixOpenReport["hostProfile"]>,
): Record<string, string | number | boolean> {
	const attributes: Record<string, string | number | boolean> = {};
	if (profile.version === 1) attributes.version = 1;
	if (typeof profile.wasm.realmReused === "boolean")
		attributes["wasm.realm_reused"] = profile.wasm.realmReused;
	if (["bundled", "cache", "network", "realm"].includes(profile.wasm.source))
		attributes["wasm.source"] = profile.wasm.source;
	if (
		["hit", "miss", "corrupt", "unavailable", "not_consulted"].includes(
			profile.wasm.cacheStatus,
		)
	)
		attributes["wasm.cache_status"] = profile.wasm.cacheStatus;
	const timings = {
		"wasm.wait_ms": profile.wasm.waitMs,
		"wasm.fetch_ms": profile.wasm.fetchMs,
		"wasm.compile_ms": profile.wasm.compileMs,
		"wasm.initialize_ms": profile.wasm.initializeMs,
		"component_compiler.import_ms": profile.componentCompiler.importMs,
		"component_compiler.initialize_ms": profile.componentCompiler.initializeMs,
		"provider.module_import_ms": profile.provider?.moduleImportMs,
		"provider.create_ms": profile.provider?.createMs,
		"provider.open_ms": profile.provider?.openMs,
		"provider.opfs.lock_wait_ms": profile.provider?.opfs?.lockWaitMs,
		"provider.opfs.sqlite_init_ms": profile.provider?.opfs?.sqliteInitMs,
		"provider.opfs.pool_open_ms": profile.provider?.opfs?.poolOpenMs,
		"provider.opfs.schema_init_ms": profile.provider?.opfs?.schemaInitMs,
		native_binding_open_ms: profile.nativeBindingOpenMs,
	};
	for (const [key, value] of Object.entries(timings))
		if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 3_600_000
		)
			attributes[key] = value;
	return attributes;
}
