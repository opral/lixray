import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { defineConfig } from "vite";

const workerTarget = process.env.LIXRAY_WORKER_TARGET ?? "production";
const workerConfigPath =
	workerTarget === "preview"
		? "./wrangler.preview.jsonc"
		: workerTarget === "e2e"
			? "./wrangler.e2e.jsonc"
			: "./wrangler.jsonc";

export default defineConfig(({ command }) => ({
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		cloudflare({
			configPath: workerConfigPath,
			viteEnvironment: { name: "ssr" },
			config: (config) => {
				const configuredPosthogProjectToken =
					typeof config.vars?.POSTHOG_PROJECT_TOKEN === "string"
						? config.vars.POSTHOG_PROJECT_TOKEN
						: undefined;
				const posthogProjectToken =
					process.env.POSTHOG_PROJECT_TOKEN ??
					process.env.VITE_PUBLIC_POSTHOG_TOKEN ??
					configuredPosthogProjectToken;
				const configuredPosthogHost =
					typeof config.vars?.POSTHOG_HOST === "string"
						? config.vars.POSTHOG_HOST
						: undefined;
				const posthogVars: Record<string, string> = {};
				if (
					command === "build" &&
					workerTarget === "production" &&
					posthogProjectToken?.trim()
				) {
					posthogVars.POSTHOG_PROJECT_TOKEN = posthogProjectToken.trim();
					posthogVars.POSTHOG_HOST =
						process.env.POSTHOG_HOST ??
						process.env.VITE_PUBLIC_POSTHOG_HOST ??
						configuredPosthogHost ??
						"https://us.i.posthog.com";
					posthogVars.POSTHOG_ENVIRONMENT = "production";
				}
				return {
					vars: {
						...config.vars,
						SUPABASE_JWKS_URL:
							process.env.SUPABASE_JWKS_URL ?? config.vars?.SUPABASE_JWKS_URL,
						SUPABASE_PUBLISHABLE_KEY:
							process.env.SUPABASE_PUBLISHABLE_KEY ??
							config.vars?.SUPABASE_PUBLISHABLE_KEY,
						SUPABASE_URL: process.env.SUPABASE_URL ?? config.vars?.SUPABASE_URL,
						LIXRAY_DEMO:
							process.env.LIXRAY_DEMO ?? config.vars?.LIXRAY_DEMO ?? "",
						LIXRAY_DEMO_WORKSPACE_IDS:
							process.env.LIXRAY_DEMO_WORKSPACE_IDS ??
							config.vars?.LIXRAY_DEMO_WORKSPACE_IDS ??
							"",
						...((process.env.SLATEDB_STORAGE ?? config.vars?.SLATEDB_STORAGE)
							? {
									SLATEDB_STORAGE:
										process.env.SLATEDB_STORAGE ?? config.vars?.SLATEDB_STORAGE,
								}
							: {}),
						...posthogVars,
					},
				};
			},
		}),
		tailwindcss(),
		tanstackStart({
			spa: {
				enabled: workerTarget !== "production",
				prerender: { outputPath: "/index.html" },
			},
		}),
		react(),
	],
}));
