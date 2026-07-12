import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8790);
const host = "localhost";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`;
const e2eWorkspaceId =
	process.env.LIXRAY_E2E_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000002";
const e2eCreatedWorkspaceId = "00000000-0000-4000-8000-000000000003";
const e2eStorage = process.env.E2E_SLATEDB_STORAGE ?? "memory";
const webServerTimeoutMs = Number(
	process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS ?? 300_000,
);

export default defineConfig({
	testDir: "./tests/e2e",
	testIgnore: "**/full-auth.spec.ts",
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	expect: {
		timeout: 10_000,
	},
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	globalTeardown: "./tests/e2e/global-teardown.ts",
	webServer: process.env.PLAYWRIGHT_BASE_URL
		? undefined
		: {
				command: `corepack pnpm run atelier:build && corepack pnpm exec vite dev --host ${host} --port ${port}`,
				env: {
					...process.env,
					LIXRAY_E2E_WORKSPACE_ID: e2eWorkspaceId,
					LIXRAY_E2E_WORKSPACE_IDS: `${e2eWorkspaceId},${e2eCreatedWorkspaceId}`,
					SLATEDB_STORAGE: e2eStorage,
					VITE_LIXRAY_E2E: "1",
				},
				reuseExistingServer: false,
				timeout: webServerTimeoutMs,
				url: `${baseURL}/healthz`,
			},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
