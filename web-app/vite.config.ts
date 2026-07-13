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

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		cloudflare({
			configPath: workerConfigPath,
			viteEnvironment: { name: "ssr" },
			config: (config) => ({
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
				},
			}),
		}),
		tailwindcss(),
		tanstackStart(),
		react(),
	],
});
