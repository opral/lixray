import type { PostHog, PostHogConfig, Properties } from "posthog-js";
import {
	AUTOCAPTURE_ATTRIBUTE_IGNORELIST,
	AUTOCAPTURE_SELECTOR_IGNORELIST,
	SESSION_RECORDING_BLOCK_SELECTOR,
	scrubPostHogEvent,
} from "./telemetry-privacy";
import { synchronizeTelemetryIdentity } from "./telemetry-identity";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

let client: PostHog | null = null;
let initializationPromise: Promise<PostHog | null> | null = null;
type TelemetryClient = Pick<
	PostHog,
	"get_property" | "identify" | "register" | "reset"
>;

export type TelemetryEnvironment = "dev" | "preview" | "production";

export function initializeTelemetry(
	userId?: string | null,
): Promise<PostHog | null> {
	if (client) {
		if (userId !== undefined) synchronizeTelemetryClient(client, userId);
		return Promise.resolve(client);
	}
	if (initializationPromise) {
		return initializationPromise.then((posthog) => {
			if (posthog && userId !== undefined) {
				synchronizeTelemetryClient(posthog, userId);
			}
			return posthog;
		});
	}
	initializationPromise = initializeTelemetryUncached(userId).finally(() => {
		initializationPromise = null;
	});
	return initializationPromise;
}

async function initializeTelemetryUncached(
	userId?: string | null,
): Promise<PostHog | null> {
	if (typeof window === "undefined") return null;
	const token = import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN?.trim();
	if (!token) return null;

	const host =
		import.meta.env.VITE_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
	const { default: posthog } = await import("posthog-js");
	const config = buildPostHogConfig(host);
	if (userId !== undefined) {
		config.loaded = (loadedPostHog) => {
			synchronizeTelemetryClient(loadedPostHog, userId);
		};
	}
	posthog.init(token, config);
	registerTelemetryEnvironment(posthog);
	client = posthog;
	return client;
}

function synchronizeTelemetryClient(
	posthog: TelemetryClient,
	userId: string | null,
): void {
	synchronizeTelemetryIdentity(posthog, userId);
	registerTelemetryEnvironment(posthog);
}

function registerTelemetryEnvironment(posthog: TelemetryClient): void {
	posthog.register({
		environment: telemetryEnvironment(
			import.meta.env.VITE_PUBLIC_TELEMETRY_ENVIRONMENT,
			import.meta.env.PROD,
		),
	});
}

export function buildPostHogConfig(
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
