import {
	context,
	trace,
	SpanKind,
	SpanStatusCode,
	ROOT_CONTEXT,
	type Context,
	type Span,
	type Tracer,
} from "@opentelemetry/api";
import { tracer as browserTracer } from "../telemetry.ts";
import type { Lix } from "@lix-js/sdk";

interface FileOpenScope {
	span: Span;
	context: Context;
	owner: "route" | "document";
	fileId: string;
	filePath?: string;
	timer: ReturnType<typeof setTimeout>;
	settleTimer?: ReturnType<typeof setTimeout>;
	startedAtMs: number;
	rendered: boolean;
	settleDelayElapsed: boolean;
	pendingInitialReads: number;
}

const FILE_OPEN_TIMEOUT_MS = 60_000;
const DOCUMENT_EFFECT_GRACE_MS = 500;

function callMethod(method: unknown, target: object, args: unknown[]): unknown {
	return (method as (...args: unknown[]) => unknown).apply(target, args);
}

/** One user-visible file open, shared across React effects and SDK worker calls. */
export function createBrowserFileOpenTraceController(
	repositoryId: string,
	replicaMode: "partial_replica" | "remote",
	tracer: Tracer = browserTracer,
) {
	let active: FileOpenScope | undefined;
	let completedFileId: string | undefined;

	const finish = (scope: FileOpenScope, outcome: string, failed = false) => {
		if (active !== scope) return;
		active = undefined;
		clearTimeout(scope.timer);
		if (scope.settleTimer) clearTimeout(scope.settleTimer);
		scope.span.setAttribute("lixray.file.open.outcome", outcome);
		if (failed) {
			scope.span.setAttribute("error.type", outcome);
			scope.span.setStatus({ code: SpanStatusCode.ERROR });
		}
		scope.span.end();
		completedFileId = outcome === "loaded" ? scope.fileId : undefined;
	};

	const start = (
		owner: FileOpenScope["owner"],
		fileId: string,
		filePath?: string,
	): FileOpenScope => {
		if (active) finish(active, "superseded");
		completedFileId = undefined;
		const span = tracer.startSpan(
			"lixray.file.open",
			{
				kind: SpanKind.INTERNAL,
				attributes: {
					"lix.id": repositoryId,
					"lix.replica.mode": replicaMode,
					"lix.file.id": fileId,
				},
			},
			ROOT_CONTEXT,
		);
		const scope: FileOpenScope = {
			span,
			context: trace.setSpan(ROOT_CONTEXT, span),
			owner,
			fileId,
			filePath,
			startedAtMs: performance.now(),
			rendered: false,
			settleDelayElapsed: false,
			pendingInitialReads: 0,
			timer: setTimeout(() => {
				if (active === scope) finish(scope, "timeout", true);
			}, FILE_OPEN_TIMEOUT_MS),
		};
		active = scope;
		return scope;
	};
	const maybeFinishLoaded = (scope: FileOpenScope) => {
		if (
			active === scope &&
			scope.rendered &&
			scope.settleDelayElapsed &&
			scope.pendingInitialReads === 0
		)
			finish(scope, "loaded");
	};

	return {
		/** Called by the route before repository opening or file lookup begins. */
		ensureRoute(fileId: string): void {
			if (active?.fileId === fileId) {
				active.owner = "route";
				return;
			}
			if (!active && completedFileId === fileId) return;
			start("route", fileId);
		},
		/** A retry is a new open even when the route and file ID are unchanged. */
		ensureRepositoryAttempt(fileId: string): void {
			if (active?.fileId === fileId) {
				active.owner = "route";
				return;
			}
			start("route", fileId);
		},
		/** Atelier also opens files without a fresh URL route. */
		documentAttempted(
			filePath: string,
			fileId: string,
			supported: boolean,
			navigationCause: "foreground" | "route" | "restoration",
		): void {
			// Restored tabs must not steal an ongoing user-visible open. A foreground
			// open can precede the URL change, so begin its root at this event.
			if (
				active &&
				active.fileId !== fileId &&
				navigationCause === "restoration"
			)
				return;
			if (!active || active.fileId !== fileId) {
				start(
					navigationCause === "route" ? "route" : "document",
					fileId,
					filePath,
				);
			} else {
				active.filePath = filePath;
			}
			if (!supported && active) finish(active, "unsupported");
		},
		resolved(fileId: string, filePath: string): void {
			if (active?.fileId !== fileId) return;
			if (active?.fileId === fileId) active.filePath = filePath;
		},
		documentLoaded(filePath: string, fileId: string | undefined): void {
			const scope = active;
			if (
				!scope ||
				scope.fileId !== fileId ||
				scope.filePath !== filePath ||
				scope.rendered
			)
				return;
			scope.rendered = true;
			scope.span.setAttribute(
				"lixray.file.open.render_ms",
				Math.round(performance.now() - scope.startedAtMs),
			);
			// Child effects (including CSV's live observer) begin after the static
			// document commits. Keep the parent until their initial reads settle.
			scope.settleTimer = setTimeout(() => {
				scope.settleDelayElapsed = true;
				maybeFinishLoaded(scope);
			}, DOCUMENT_EFFECT_GRACE_MS);
		},
		failed(fileId: string): void {
			if (active?.fileId === fileId) finish(active, "file_open_failed", true);
		},
		cancel(): void {
			if (active) finish(active, "cancelled");
			completedFileId = undefined;
		},
		run<T>(operation: () => T): T {
			return active ? context.with(active.context, operation) : operation();
		},
		/** Scoped handle for document loaders and React effects, never the shell. */
		scopeLix(filePath: string, fileId: string | undefined, lix: Lix): Lix {
			const run = <T>(operation: () => T, track = false): T => {
				const scope = active?.fileId === fileId ? active : undefined;
				if (scope && scope.filePath === undefined) scope.filePath = filePath;
				const result = scope
					? context.with(scope.context, operation)
					: operation();
				if (
					scope &&
					track &&
					result &&
					typeof (result as unknown as PromiseLike<unknown>).then === "function"
				) {
					scope.pendingInitialReads++;
					void Promise.resolve(result).then(
						() => {
							scope.pendingInitialReads--;
							maybeFinishLoaded(scope);
						},
						() => {
							scope.pendingInitialReads--;
							maybeFinishLoaded(scope);
						},
					);
				}
				return result;
			};
			return new Proxy(lix, {
				get(target, key) {
					const value = Reflect.get(target, key, target) as unknown;
					if (typeof value !== "function") return value;
					if (key === "observe") {
						return (...args: unknown[]) => {
							let firstNext = true;
							const iterable = run(() =>
								callMethod(value, target, args),
							) as object;
							return new Proxy(iterable, {
								get(source, iteratorKey, iteratorProxy: object) {
									if (iteratorKey === Symbol.asyncIterator)
										return () => iteratorProxy;
									const method = Reflect.get(source, iteratorKey) as unknown;
									return typeof method === "function"
										? (...methodArgs: unknown[]) => {
												const track = iteratorKey === "next" && firstNext;
												if (track) firstNext = false;
												return run(
													() => callMethod(method, source, methodArgs),
													track,
												);
											}
										: method;
								},
							});
						};
					}
					return (...args: unknown[]) =>
						run(() => callMethod(value, target, args), true);
				},
			}) as Lix;
		},
	};
}

export type BrowserFileOpenTraceController = ReturnType<
	typeof createBrowserFileOpenTraceController
>;
