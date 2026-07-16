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

export async function fetchContainerWithRetry(
	options: FetchContainerWithRetryOptions,
): Promise<Response> {
	const retryDelay = options.retryDelay ?? delay;
	const retryRandom = options.retryRandom ?? Math.random;
	let retryCount = 0;

	for (;;) {
		throwIfAborted(options.signal);
		let retryError: unknown;
		try {
			// A Durable Object reset creates a new object incarnation. Reacquiring the
			// stub on every attempt avoids retaining an RPC session from the reset one.
			const container = options.namespace.getByName(options.workspaceId);
			await container.startAndWaitForPorts?.({
				ports: 8080,
				cancellationOptions: { abort: options.signal },
				startOptions: { envVars: options.envVars },
			});
			const response = await container.fetch(options.createRequest());
			const responseFailure = await retryableResponseFailure(response);
			if (!responseFailure) return response;
			await cancelResponseBody(response);
			retryError = responseFailure;
		} catch (caught) {
			throwIfAborted(options.signal);
			if (!isRetryableContainerError(caught)) throw caught;
			retryError = caught;
		}

		retryCount += 1;
		const retryDelayMs = containerRetryDelayMs(retryCount, retryRandom);
		options.onRetry?.({
			workspaceId: options.workspaceId,
			operation: options.operation,
			retryCount,
			retryDelayMs,
			error: retryError,
		});
		await retryDelay(retryDelayMs, options.signal);
	}
}

export function isRetryableContainerError(caught: unknown): boolean {
	const message = errorMessageWithCauses(caught).toLowerCase();
	if (message.includes("abort")) return false;

	const exitCode = containerExitCode(message);
	if (exitCode !== null && exitCode !== 0) return false;

	return RETRYABLE_CONTAINER_ERROR_FRAGMENTS.some((fragment) =>
		message.includes(fragment),
	);
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
		error:
			observation.error instanceof Error
				? {
						name: observation.error.name,
						message: observation.error.message,
						stack: observation.error.stack,
					}
				: observation.error,
	});
}

async function retryableResponseFailure(
	response: Response,
): Promise<Record<string, unknown> | null> {
	if ([429, 502, 503, 504].includes(response.status)) {
		return { status: response.status };
	}
	if (response.status !== 500) return null;

	const body = await parseResponse(response.clone());
	const message = responseErrorMessage(body, response.status);
	return isRetryableContainerError(message)
		? { status: response.status, message }
		: null;
}

async function parseResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	return contentType.includes("application/json")
		? response.json()
		: response.text();
}

function responseErrorMessage(body: unknown, status: number): string {
	if (body && typeof body === "object" && "error" in body) {
		const error = body.error;
		if (
			error &&
			typeof error === "object" &&
			"message" in error &&
			typeof error.message === "string"
		) {
			return error.message;
		}
	}
	if (typeof body === "string" && body.trim()) return body.trim();
	return `Container request failed with status ${status}.`;
}

function errorMessageWithCauses(caught: unknown): string {
	const messages: Array<string> = [];
	const seen = new Set<unknown>();
	let current = caught;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			messages.push(current.message);
			current = current.cause;
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

function containerExitCode(message: string): number | null {
	const match = /exit code:\s*(-?\d+)/.exec(message);
	return match ? Number(match[1]) : null;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("Container request was cancelled.", "AbortError");
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response is being discarded before the next attempt either way.
	}
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("Container request was cancelled.", "AbortError"),
			);
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(
				signal?.reason instanceof Error
					? signal.reason
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
