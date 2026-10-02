import { repositoryOpenDiagnostics } from "./repository-open-telemetry.ts";
import type {
	LogAttributes,
	PostHog,
	PostHogConfig,
	Properties,
} from "posthog-js";
import {
	AUTOCAPTURE_ATTRIBUTE_IGNORELIST,
	AUTOCAPTURE_SELECTOR_IGNORELIST,
	SESSION_RECORDING_BLOCK_SELECTOR,
} from "./telemetry-privacy.ts";
import {
	exceptionTraceability,
	preparePostHogEvent,
} from "./exception-traceability.ts";
import {
	safeLixErrorCode,
	safeRustErrorOriginInCauseChain,
	safeRustStacktraceStatus,
} from "./exception-stack-trace.ts";
import { BROWSER_EXCEPTION_CAPTURE_CONFIG } from "./telemetry-exceptions.ts";
import type { ProductEvent } from "./telemetry-events.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

let client: PostHog | null = null;
let initializationPromise: Promise<PostHog | null> | null = null;

/** Extracts the stable, non-content fields exposed by the Lix remote SDK. */
export function lixErrorTelemetryProperties(error: unknown): Properties {
	if (!error || typeof error !== "object") return {};
	const candidate = error as {
		name?: unknown;
		code?: unknown;
		status?: unknown;
		hint?: unknown;
		rustOrigin?: unknown;
		rustStacktraceStatus?: unknown;
		details?: { httpStatus?: unknown };
	};
	const code = safeLixErrorCode(candidate.code);
	const locatedRustOrigin = safeRustErrorOriginInCauseChain(error);
	const rustOrigin = locatedRustOrigin?.origin;
	const rustStacktraceStatus =
		locatedRustOrigin?.rustStacktraceStatus ?? safeRustStacktraceStatus(error);
	if (
		candidate.name !== "LixError" &&
		!code?.startsWith("LIX_") &&
		!rustOrigin &&
		!rustStacktraceStatus
	)
		return {};
	const status =
		typeof candidate.status === "number"
			? candidate.status
			: typeof candidate.details?.httpStatus === "number"
				? candidate.details.httpStatus
				: undefined;

	return {
		...repositoryOpenDiagnostics(error),
		...(rustOrigin ? { rust_origin: rustOrigin } : {}),
		...(locatedRustOrigin?.causeIndex !== undefined
			? { rust_origin_cause_index: locatedRustOrigin.causeIndex }
			: {}),
		...(rustStacktraceStatus
			? { rust_stacktrace_status: rustStacktraceStatus }
			: {}),
		...(code ? { lix_error_code: code } : {}),
		...(status !== undefined ? { lix_error_status: status } : {}),
	};
}

type TelemetryEnvironment = "dev" | "preview" | "production";

export function initializeTelemetry(): Promise<PostHog | null> {
	if (client) return Promise.resolve(client);
	if (initializationPromise) return initializationPromise;
	initializationPromise = initializeTelemetryUncached().finally(() => {
		initializationPromise = null;
	});
	return initializationPromise;
}

async function initializeTelemetryUncached(): Promise<PostHog | null> {
	if (typeof window === "undefined") return null;
	const token = import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN?.trim();
	if (!token) return null;

	const host =
		import.meta.env.VITE_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
	const { default: posthog } = await import("posthog-js");
	posthog.init(token, buildPostHogConfig(host));
	registerTelemetryEnvironment(posthog);
	client = posthog;
	return client;
}

export function resetTelemetry(): void {
	if (!client) return;
	client.reset();
	registerTelemetryEnvironment(client);
}

function registerTelemetryEnvironment(
	posthog: Pick<PostHog, "register">,
): void {
	posthog.register({
		client_release: import.meta.env.VITE_LIXRAY_RELEASE_ID ?? "unknown",
		environment: telemetryEnvironment(
			import.meta.env.VITE_PUBLIC_TELEMETRY_ENVIRONMENT,
			import.meta.env.PROD,
		),
	});
}

function buildPostHogConfig(
	host = DEFAULT_POSTHOG_HOST,
): Partial<PostHogConfig> {
	const environment = telemetryEnvironment(
		import.meta.env.VITE_PUBLIC_TELEMETRY_ENVIRONMENT,
		import.meta.env.PROD,
	);
	return {
		api_host: host,
		defaults: "2026-05-30",
		autocapture: {
			element_attribute_ignorelist: AUTOCAPTURE_ATTRIBUTE_IGNORELIST,
			css_selector_ignorelist: AUTOCAPTURE_SELECTOR_IGNORELIST,
			capture_copied_text: false,
		},
		before_send: preparePostHogEvent,
		capture_exceptions: BROWSER_EXCEPTION_CAPTURE_CONFIG,
		capture_pageview: "history_change",
		capture_pageleave: true,
		disable_session_recording: false,
		logs: {
			captureConsoleLogs: false,
			environment,
			serviceName: "lixray-web",
		},
		mask_all_text: true,
		person_profiles: "identified_only",
		session_recording: {
			maskAllInputs: true,
			maskTextSelector: "*",
			blockSelector: SESSION_RECORDING_BLOCK_SELECTOR,
		},
	};
}

/** Sends an intentionally content-free structured error to PostHog Logs. */
export async function captureErrorLogImmediately(
	body: string,
	attributes: LogAttributes = {},
): Promise<void> {
	try {
		const posthog = await initializeTelemetry();
		if (!posthog) return;
		posthog.captureLog({ body, level: "error", attributes });
		posthog.logs?.flushLogs("sendBeacon");
	} catch (error: unknown) {
		console.warn("Failed to capture browser error log", error);
	}
}

export function captureTelemetry(
	event: ProductEvent,
	properties: Properties = {},
): void {
	void initializeTelemetry()
		.then((posthog) => {
			posthog?.capture(event, { ...properties, surface: "web" });
		})
		.catch((error: unknown) => {
			console.warn("Failed to capture browser telemetry", error);
		});
}

/** Captures before identity reset or navigation and bypasses request batching. */
export async function captureTelemetryImmediately(
	event: ProductEvent,
	properties: Properties = {},
): Promise<void> {
	try {
		const posthog = await initializeTelemetry();
		posthog?.capture(
			event,
			{ ...properties, surface: "web" },
			{ send_instantly: true },
		);
	} catch (error: unknown) {
		console.warn("Failed to capture browser telemetry", error);
	}
}

export function captureExceptionTelemetry(
	error: unknown,
	properties: Properties = {},
): void {
	const captured = exceptionTraceability({
		...lixErrorTelemetryProperties(error),
		...properties,
	});
	void initializeTelemetry()
		.then((posthog) => {
			posthog?.captureException(error, captured);
		})
		.catch((telemetryError: unknown) => {
			console.warn("Failed to capture browser exception", telemetryError);
		});
}

/** Ensures handled exception capture is invoked before identity reset. */
export async function captureExceptionTelemetryAsync(
	error: unknown,
	properties: Properties = {},
): Promise<void> {
	const captured = exceptionTraceability({
		...lixErrorTelemetryProperties(error),
		...properties,
	});
	try {
		const posthog = await initializeTelemetry();
		posthog?.captureException(error, captured);
	} catch (telemetryError: unknown) {
		console.warn("Failed to capture browser exception", telemetryError);
	}
}

export function telemetryEnvironment(
	configuredValue: string | undefined,
	isProduction: boolean,
): TelemetryEnvironment {
	const configured = configuredValue?.trim().toLowerCase();
	if (configured === "production" || configured === "preview") {
		return configured;
	}
	if (configured === "dev" || configured === "development") return "dev";
	return isProduction ? "production" : "dev";
}
