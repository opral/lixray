import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8790);
const host = "localhost";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`;
const demoWorkspaceId = "00000000-0000-4000-8000-000000000002";
const demoCreatedWorkspaceId = "00000000-0000-4000-8000-000000000003";
const webServerTimeoutMs = Number(
	process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS ?? 300_000,
);
const localStatePath = `.wrangler/e2e-${process.pid}`;

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
	webServer: process.env.PLAYWRIGHT_BASE_URL
		? undefined
		: {
				command: `pnpm run build:preview && pnpm exec wrangler dev --config ./wrangler.preview-runtime.jsonc --persist-to ${localStatePath} --ip ${host} --port ${port}`,
				env: {
					...process.env,
					LIXRAY_WORKER_TARGET: "e2e",
					LIXRAY_DEMO: "1",
					LIXRAY_DEMO_WORKSPACE_IDS: `${demoWorkspaceId},${demoCreatedWorkspaceId}`,
					VITE_LIXRAY_DEMO: "1",
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
