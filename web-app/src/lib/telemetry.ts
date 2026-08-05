import type { PostHog, PostHogConfig, Properties } from "posthog-js";
import {
	AUTOCAPTURE_ATTRIBUTE_IGNORELIST,
	AUTOCAPTURE_SELECTOR_IGNORELIST,
	SESSION_RECORDING_BLOCK_SELECTOR,
	scrubPostHogEvent,
} from "./telemetry-privacy.ts";
import { BROWSER_EXCEPTION_CAPTURE_CONFIG } from "./telemetry-exceptions.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

let client: PostHog | null = null;
let initializationPromise: Promise<PostHog | null> | null = null;

const MAX_LIX_TELEMETRY_STRING_LENGTH = 200;

/** Extracts the stable, non-content fields exposed by the Lix remote SDK. */
export function lixErrorTelemetryProperties(error: unknown): Properties {
	if (!error || typeof error !== "object") return {};
	const candidate = error as {
		name?: unknown;
		code?: unknown;
		status?: unknown;
		hint?: unknown;
	};
	const code = typeof candidate.code === "string" ? candidate.code : undefined;
	if (candidate.name !== "LixError" && !code?.startsWith("LIX_")) return {};

	return {
		...(code
			? { lix_error_code: code.slice(0, MAX_LIX_TELEMETRY_STRING_LENGTH) }
			: {}),
		...(typeof candidate.status === "number"
			? { lix_error_status: candidate.status }
			: {}),
		...(typeof candidate.hint === "string"
			? {
					lix_error_hint: candidate.hint.slice(
						0,
						MAX_LIX_TELEMETRY_STRING_LENGTH,
					),
				}
			: {}),
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
		environment: telemetryEnvironment(
			import.meta.env.VITE_PUBLIC_TELEMETRY_ENVIRONMENT,
			import.meta.env.PROD,
		),
	});
}

function buildPostHogConfig(
	host = DEFAULT_POSTHOG_HOST,
): Partial<PostHogConfig> {
	return {
		api_host: host,
		defaults: "2026-05-30",
		autocapture: {
			element_attribute_ignorelist: AUTOCAPTURE_ATTRIBUTE_IGNORELIST,
			css_selector_ignorelist: AUTOCAPTURE_SELECTOR_IGNORELIST,
			capture_copied_text: false,
		},
		before_send: scrubPostHogEvent,
		capture_exceptions: BROWSER_EXCEPTION_CAPTURE_CONFIG,
		capture_pageview: "history_change",
		capture_pageleave: true,
		disable_session_recording: false,
		mask_all_text: true,
		person_profiles: "identified_only",
		session_recording: {
			maskAllInputs: true,
			maskTextSelector: "*",
			blockSelector: SESSION_RECORDING_BLOCK_SELECTOR,
		},
	};
}

export function captureTelemetry(
	event: string,
	properties: Properties = {},
): void {
	void initializeTelemetry()
		.then((posthog) => {
			posthog?.capture(event, properties);
		})
		.catch((error: unknown) => {
			console.warn("Failed to capture browser telemetry", error);
		});
}

export function captureExceptionTelemetry(
	error: unknown,
	properties: Properties = {},
): void {
	void initializeTelemetry()
		.then((posthog) => {
			posthog?.captureException(error, {
				...lixErrorTelemetryProperties(error),
				...properties,
			});
		})
		.catch((telemetryError: unknown) => {
			console.warn("Failed to capture browser exception", telemetryError);
		});
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
