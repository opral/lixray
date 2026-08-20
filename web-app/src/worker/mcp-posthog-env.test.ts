import assert from "node:assert/strict";
import test from "node:test";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	isRailwayPullRequestEnvironment,
	resolveOfficialMcpPosthogToken,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

void test("project token prefers POSTHOG_PROJECT_TOKEN over the public Vite token", () => {
	assert.equal(
		resolvePosthogProjectToken({
			POSTHOG_PROJECT_TOKEN: " phc_server_token ",
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_token",
			POSTHOG_API_KEY: "phx_personal_api_key",
		}),
		"phc_server_token",
	);
});

void test("project token falls back to VITE_PUBLIC_POSTHOG_TOKEN", () => {
	assert.equal(
		resolvePosthogProjectToken({
			VITE_PUBLIC_POSTHOG_TOKEN: " phc_public_token ",
			POSTHOG_API_KEY: "phx_personal_api_key",
		}),
		"phc_public_token",
	);
});

void test("POSTHOG_API_KEY alone does not resolve a capture token", () => {
	assert.equal(
		resolvePosthogProjectToken({
			POSTHOG_API_KEY: "phx_personal_api_key",
		}),
		undefined,
	);
	assert.equal(
		resolveOfficialMcpPosthogToken({
			POSTHOG_API_KEY: "phx_personal_api_key",
		}),
		undefined,
	);
});

void test("official token is independent of POSTHOG_ENVIRONMENT", () => {
	assert.equal(
		resolveOfficialMcpPosthogToken({
			POSTHOG_PROJECT_TOKEN: "phc_server_token",
		}),
		"phc_server_token",
	);
	assert.equal(
		resolveOfficialMcpPosthogToken({
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_token",
		}),
		"phc_public_token",
	);
});

void test("official token is omitted in demo and Railway PR environments", () => {
	assert.equal(
		resolveOfficialMcpPosthogToken({
			POSTHOG_PROJECT_TOKEN: "phc_server_token",
			LIXRAY_DEMO: "1",
		}),
		undefined,
	);
	assert.equal(
		resolveOfficialMcpPosthogToken(
			{ POSTHOG_PROJECT_TOKEN: "phc_server_token" },
			{ isDemo: true },
		),
		undefined,
	);
	assert.equal(
		resolveOfficialMcpPosthogToken({
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_token",
			RAILWAY_ENVIRONMENT_NAME: "lixray-pr-91",
		}),
		undefined,
	);
	assert.equal(
		resolveOfficialMcpPosthogToken({
			POSTHOG_PROJECT_TOKEN: "phc_server_token",
			RAILWAY_ENVIRONMENT_NAME: "pr-11b179-85",
		}),
		undefined,
	);
});

void test("production telemetry accepts Railway and Vite environment signals", () => {
	assert.equal(
		isProductionTelemetryEnvironment({ POSTHOG_ENVIRONMENT: "production" }),
		true,
	);
	assert.equal(
		isProductionTelemetryEnvironment({
			RAILWAY_ENVIRONMENT_NAME: "production",
		}),
		true,
	);
	assert.equal(
		isProductionTelemetryEnvironment({
			VITE_PUBLIC_TELEMETRY_ENVIRONMENT: "production",
		}),
		true,
	);
	assert.equal(
		isProductionTelemetryEnvironment({ POSTHOG_ENVIRONMENT: "preview" }),
		false,
	);
	assert.equal(isProductionTelemetryEnvironment({}), false);
});

void test("demo and Railway PR environment detection stays aligned", () => {
	assert.equal(isRailwayPullRequestEnvironment("lixray-pr-91"), true);
	assert.equal(isRailwayPullRequestEnvironment("pr-11b179-85"), true);
	assert.equal(isRailwayPullRequestEnvironment("production"), false);
	assert.equal(isDemoEnvironment({ LIXRAY_DEMO: "1" }), true);
	assert.equal(
		isDemoEnvironment({ RAILWAY_ENVIRONMENT_NAME: "lixray-pr-12" }),
		true,
	);
	assert.equal(
		isDemoEnvironment({ RAILWAY_ENVIRONMENT_NAME: "production" }),
		false,
	);
});
