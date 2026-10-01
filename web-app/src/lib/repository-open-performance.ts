import {
	context,
	trace,
	ROOT_CONTEXT,
	SpanStatusCode,
	type Tracer,
} from "@opentelemetry/api";
import { tracer } from "../telemetry.ts";

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
		  }
		| undefined;
	const timestamp = (ms: number) => origin() + ms;
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
