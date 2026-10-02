import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LIXRAY_SNAPSHOT_PORT ?? 8796);
const host = "127.0.0.1";

export default defineConfig({
	testDir: ".",
	testMatch: ["snapshot-download.spec.ts", "repository-opening.spec.ts"],
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	expect: { timeout: 10_000 },
	use: {
		baseURL: `http://${host}:${port}`,
		trace: "retain-on-failure",
	},
	webServer: {
		command: "pnpm exec vite --config tests/file-component/vite.config.ts",
		env: {
			...process.env,
			LIXRAY_COMPONENT_PORT: String(port),
			VITE_PUBLIC_TELEMETRY_ENVIRONMENT: "dev",
			VITE_LIXRAY_RELEASE_ID: "snapshot-fixture-release",
		},
		url: `http://${host}:${port}/snapshot.html`,
		reuseExistingServer: false,
		timeout: 60_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
