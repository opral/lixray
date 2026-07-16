export interface ContainerNamespace {
	getByName(name: string): ContainerStub;
}

export interface ContainerStub {
	startAndWaitForPorts?(options: {
		ports?: number | number[];
		cancellationOptions?: {
			abort?: AbortSignal;
			instanceGetTimeoutMS?: number;
			portReadyTimeoutMS?: number;
			waitInterval?: number;
		};
		startOptions: { envVars: Record<string, string> };
	}): Promise<unknown>;
	fetch(request: Request): Promise<Response>;
}

export type ContainerRetryDelay = (
	milliseconds: number,
	signal?: AbortSignal,
) => Promise<void>;

export interface ContainerRetryObservation {
	workspaceId: string;
	operation: string;
	retryCount: number;
	retryDelayMs: number;
	error: unknown;
}

export interface FetchContainerWithRetryOptions {
	namespace: ContainerNamespace;
	workspaceId: string;
	operation: string;
	envVars: Record<string, string>;
	createRequest: () => Request;
	requestReplay: "safe" | "unsafe";
	signal?: AbortSignal;
	retryDelay?: ContainerRetryDelay;
	retryRandom?: () => number;
	onRetry?: (observation: ContainerRetryObservation) => void;
}

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5_000;

const RETRYABLE_CONTAINER_ERROR_FRAGMENTS = [
	"container is not running",
	"there is no container instance",
	"too many containers per second",
	"container crashed",
	"container exited before",
	"failed to start container",
	"failed to verify port",
	"network connection lost",
	"container suddenly disconnected",
	"error proxying request to container",
	"container is not listening",
	"connection refused",
	"connection reset",
	"fetch failed",
	"timed out",
	"timeout",
	"internal error in durable object storage caused object to be reset",
	"durable object reset because its code was updated",
	"runtime signalled the container to exit due to a new version rollout",
];

const CONTAINER_NOT_READY_ERROR_FRAGMENTS = [
	"container is not running",
	"there is no container instance",
	"too many containers per second",
	"failed to start container",
	"failed to verify port",
	"container is not listening",
];

export async function fetchContainerWithRetry(
	options: FetchContainerWithRetryOptions,
): Promise<Response> {
	const retryDelay = options.retryDelay ?? delay;
	const retryRandom = options.retryRandom ?? Math.random;
	let retryCount = 0;

	for (;;) {
		throwIfAborted(options.signal);
		let container: ContainerStub;
		try {
			// A Durable Object reset creates a new object incarnation. Reacquiring the
			// stub on every attempt avoids retaining an RPC session from the reset one.
			container = options.namespace.getByName(options.workspaceId);
			const startup = container.startAndWaitForPorts?.({
				ports: 8080,
				startOptions: { envVars: options.envVars },
			});
			if (startup) await waitForPromiseWithAbort(startup, options.signal);
		} catch (caught) {
			throwIfAborted(options.signal);
			if (!isRetryableContainerError(caught)) throw caught;
			await waitBeforeContainerRetry(
				options,
				caught,
				++retryCount,
				retryDelay,
				retryRandom,
			);
			continue;
		}

		// Constructing the request happens after startup and outside a retry catch so
		// local serialization/programming failures are never mistaken for churn.
		const request = options.createRequest();
		let response: Response;
		try {
			response = await waitForPromiseWithAbort(
				container.fetch(request),
				options.signal,
			);
		} catch (caught) {
			throwIfAborted(options.signal);
			const canReplay =
				options.requestReplay === "safe" || isContainerNotReadyError(caught);
			if (!canReplay || !isRetryableContainerError(caught)) throw caught;
			await waitBeforeContainerRetry(
				options,
				caught,
				++retryCount,
				retryDelay,
				retryRandom,
			);
			continue;
		}

		const responseFailure = await retryableResponseFailure(
			response,
			options.requestReplay,
		);
		if (!responseFailure) return response;
		await cancelResponseBody(response);
		await waitBeforeContainerRetry(
			options,
			responseFailure,
			++retryCount,
			retryDelay,
			retryRandom,
		);
	}
}

export function isRetryableContainerError(caught: unknown): boolean {
	const message = errorMessageWithCauses(caught).toLowerCase();
	if (isDataCloneError(caught) || message.includes("abort")) return false;

	const exitCode = containerExitCode(message);
	if (exitCode !== null && exitCode !== 0) return false;
	if (hasErrorFlag(caught, "overloaded", true)) return false;
	if (hasErrorFlag(caught, "retryable", true)) return true;
	if (hasErrorFlag(caught, "retryable", false)) return false;

	return RETRYABLE_CONTAINER_ERROR_FRAGMENTS.some((fragment) =>
		message.includes(fragment),
	);
}

export function containerErrorDetails(
	caught: unknown,
): Record<string, unknown> {
	return containerErrorDetailsWithSeen(caught, new Set());
}

function containerErrorDetailsWithSeen(
	caught: unknown,
	seen: Set<unknown>,
): Record<string, unknown> {
	if (!isObject(caught)) return { value: String(caught) };
	if (seen.has(caught)) return { value: "Circular error cause" };
	seen.add(caught);

	const details: Record<string, unknown> = {};
	for (const property of [
		"name",
		"message",
		"stack",
		"retryable",
		"overloaded",
	] as const) {
		const value = errorProperty(caught, property);
		if (value !== undefined) details[property] = value;
	}
	const cause = errorProperty(caught, "cause");
	if (cause !== undefined) {
		details.cause = containerErrorDetailsWithSeen(cause, seen);
	}
	return Object.keys(details).length > 0
		? details
		: { value: "Unknown container error" };
}

export function containerRetryDelayMs(
	retryCount: number,
	random: () => number = Math.random,
): number {
	const exponent = Math.min(Math.max(retryCount - 1, 0), 3);
	const ceiling = Math.min(
		MAX_RETRY_DELAY_MS,
		BASE_RETRY_DELAY_MS * 2 ** exponent,
	);
	const floor = Math.ceil(ceiling / 2);
	const jitter = Math.min(Math.max(random(), 0), 1);
	return Math.round(floor + (ceiling - floor) * jitter);
}

export function logContainerRetry(
	observation: ContainerRetryObservation,
): void {
	if (observation.retryCount !== 1 && observation.retryCount % 30 !== 0) return;
	console.warn("Transient LixRay container failure; retrying", {
		workspaceId: observation.workspaceId,
		operation: observation.operation,
		retryCount: observation.retryCount,
		retryDelayMs: observation.retryDelayMs,
		error: containerErrorDetails(observation.error),
	});
}

async function retryableResponseFailure(
	response: Response,
	requestReplay: "safe" | "unsafe",
): Promise<Record<string, unknown> | null> {
	if (![429, 500, 502, 503, 504].includes(response.status)) return null;

	let body: unknown;
	try {
		body = await parseResponse(response.clone());
	} catch {
		return null;
	}
	const error = responseError(body, response.status);
	const canReplay =
		requestReplay === "safe"
			? isRetryableContainerError(error)
			: isContainerNotReadyError(error);
	return canReplay
		? { status: response.status, error: containerErrorDetails(error) }
		: null;
}

async function parseResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	return contentType.includes("application/json")
		? response.json()
		: response.text();
}

function responseError(body: unknown, status: number): unknown {
	if (body && typeof body === "object" && "error" in body) {
		const error = body.error;
		if (error !== undefined) return error;
	}
	if (body && typeof body === "object") return body;
	if (typeof body === "string" && body.trim()) return body.trim();
	return `Container request failed with status ${status}.`;
}

function errorMessageWithCauses(caught: unknown): string {
	const messages: Array<string> = [];
	const seen = new Set<unknown>();
	let current = caught;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (isObject(current)) {
			const message = errorProperty(current, "message");
			messages.push(
				typeof message === "string" ? message : "Unknown container error",
			);
			current = errorProperty(current, "cause");
		} else if (
			typeof current === "string" ||
			typeof current === "number" ||
			typeof current === "boolean" ||
			typeof current === "bigint"
		) {
			messages.push(String(current));
			break;
		} else {
			messages.push("Unknown container error");
			break;
		}
	}
	return messages.join(" ");
}

function isContainerNotReadyError(caught: unknown): boolean {
	if (!isRetryableContainerError(caught)) return false;
	const message = errorMessageWithCauses(caught).toLowerCase();
	return CONTAINER_NOT_READY_ERROR_FRAGMENTS.some((fragment) =>
		message.includes(fragment),
	);
}

function isDataCloneError(caught: unknown): boolean {
	let current = caught;
	const seen = new Set<unknown>();
	while (isObject(current) && !seen.has(current)) {
		seen.add(current);
		if (errorProperty(current, "name") === "DataCloneError") return true;
		current = errorProperty(current, "cause");
	}
	return false;
}

function hasErrorFlag(
	caught: unknown,
	property: "retryable" | "overloaded",
	expected: boolean,
): boolean {
	let current = caught;
	const seen = new Set<unknown>();
	while (isObject(current) && !seen.has(current)) {
		seen.add(current);
		if (errorProperty(current, property) === expected) return true;
		current = errorProperty(current, "cause");
	}
	return false;
}

function isObject(value: unknown): value is object {
	return (
		(typeof value === "object" && value !== null) || typeof value === "function"
	);
}

function errorProperty(value: object, property: string): unknown {
	try {
		return Reflect.get(value, property);
	} catch {
		return undefined;
	}
}

function containerExitCode(message: string): number | null {
	const match = /exit code:\s*(-?\d+)/.exec(message);
	return match ? Number(match[1]) : null;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
	if (!signal?.aborted) return;
	throw abortReason(signal);
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response is being discarded before the next attempt either way.
	}
}

async function waitBeforeContainerRetry(
	options: FetchContainerWithRetryOptions,
	error: unknown,
	retryCount: number,
	retryDelay: ContainerRetryDelay,
	retryRandom: () => number,
): Promise<void> {
	const retryDelayMs = containerRetryDelayMs(retryCount, retryRandom);
	options.onRetry?.({
		workspaceId: options.workspaceId,
		operation: options.operation,
		retryCount,
		retryDelayMs,
		error,
	});
	await retryDelay(retryDelayMs, options.signal);
}

function waitForPromiseWithAbort<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onFulfilled = (value: T) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const onRejected = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				error instanceof Error
					? error
					: new Error("Container operation failed.", { cause: error }),
			);
		};
		const onAbort = () => onRejected(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(onFulfilled, onRejected);
	});
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Container request was cancelled.", "AbortError");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(
				signal
					? abortReason(signal)
					: new DOMException("Container request was cancelled.", "AbortError"),
			);
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
