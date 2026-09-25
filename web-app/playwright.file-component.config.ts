import { defineConfig } from "@playwright/test";
const port = Number(process.env.LIXRAY_COMPONENT_PORT ?? 8795);
export default defineConfig({
	testDir: "./tests/file-component",
	testMatch: "*.spec.ts",
	timeout: 30_000,
	fullyParallel: true,
	workers: 2,
	// The development server serves many small modules during a fresh browser
	// load. Chromium can transiently cancel those requests with
	// ERR_NETWORK_CHANGED on shared CI hosts; retry the affected test once.
	retries: process.env.CI ? 1 : 0,
	use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
	webServer: {
		command: "pnpm exec vite --config tests/file-component/vite.config.ts",
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
	},
	// Keep the native user agent: ControlOrMeta follows the host OS, and React
	// Aria chooses the same modifier from the browser platform. A Windows device
	// preset on macOS makes those disagree (Cmd+A versus Ctrl+A).
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
