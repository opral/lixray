import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8790);
const host = "localhost";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`;
const e2eOrgId =
	process.env.LIXRAY_E2E_ORG_ID ?? `org_lixray_e2e_${process.pid}`;
const e2eStorage = process.env.E2E_SLATEDB_STORAGE ?? "memory";
const webServerTimeoutMs = Number(
	process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS ?? 300_000,
);

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
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
				command: `pnpm exec vite dev --host ${host} --port ${port}`,
				env: {
					...process.env,
					CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
					LIXRAY_E2E_ORG_ID: e2eOrgId,
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
