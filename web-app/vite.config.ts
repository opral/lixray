import { cloudflare } from "@cloudflare/vite-plugin";
import posthogRollupPlugin from "@posthog/rollup-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const webAppDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(webAppDir, "..");
const atelierSourceDir = path.resolve(repositoryRoot, "vendor/atelier/src");

const workerTarget = process.env.LIXRAY_WORKER_TARGET ?? "production";
const workerConfigPath =
	workerTarget === "railway" ? "./wrangler.railway.jsonc" : "./wrangler.jsonc";

function requiredProductionSourceMapVariable(
	name: "POSTHOG_API_KEY" | "POSTHOG_PROJECT_ID",
): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(
			`${name} is required to upload PostHog source maps in production`,
		);
	}
	return value;
}

function posthogSourceMapPlugins(command: string) {
	const uploadPostHogSourceMaps =
		command === "build" &&
		workerTarget === "railway" &&
		process.env.RAILWAY_ENVIRONMENT_NAME?.trim() === "production";
	if (!uploadPostHogSourceMaps) return [];

	return [
		posthogRollupPlugin({
			personalApiKey: requiredProductionSourceMapVariable("POSTHOG_API_KEY"),
			projectId: requiredProductionSourceMapVariable("POSTHOG_PROJECT_ID"),
			host:
				process.env.POSTHOG_HOST?.trim() ||
				process.env.VITE_PUBLIC_POSTHOG_HOST?.trim() ||
				"https://us.i.posthog.com",
			sourcemaps: {
				enabled: true,
				releaseName: "lixray-web",
				releaseVersion: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined,
				deleteAfterUpload: true,
			},
		}),
	];
}

export default defineConfig(({ command }) => ({
	resolve: {
		tsconfigPaths: true,
		alias:
			command === "serve"
				? [
						{
							find: "@opral/atelier/style.css",
							replacement: path.resolve(atelierSourceDir, "index.css"),
						},
						{
							find: "@opral/atelier/file-icons",
							replacement: path.resolve(atelierSourceDir, "file-icons.ts"),
						},
						{
							find: "@opral/atelier/state-adapters",
							replacement: path.resolve(atelierSourceDir, "state-adapters.ts"),
						},
						{
							find: "@opral/atelier",
							replacement: path.resolve(atelierSourceDir, "index.ts"),
						},
						{
							find: "@",
							replacement: atelierSourceDir,
						},
					]
				: undefined,
	},
	server: {
		fs: { allow: [repositoryRoot] },
	},
	optimizeDeps: {
		// Atelier is linked source and first reached through a lazy workspace
		// route. Pre-bundle its DnD runtime before that route loads so Vite does
		// not invalidate the page with an "Outdated Optimize Dep" reload.
		include:
			command === "serve"
				? ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities"]
				: [],
		// The Lix worker is lazy-loaded after workspace navigation. Keep its
		// ESM shims out of the optimizer so first use cannot reload the page.
		exclude:
			command === "serve"
				? ["@opral/atelier", "@bytecodealliance/preview2-shim"]
				: [],
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
						LIXRAY_WORKSPACE_SERVICE_URL:
							process.env.LIXRAY_WORKSPACE_SERVICE_URL ??
							config.vars?.LIXRAY_WORKSPACE_SERVICE_URL,
						LIXRAY_INTERNAL_TOKEN:
							process.env.LIXRAY_INTERNAL_TOKEN ??
							config.vars?.LIXRAY_INTERNAL_TOKEN,
						R2_ENDPOINT: process.env.R2_ENDPOINT ?? config.vars?.R2_ENDPOINT,
						R2_BUCKET: process.env.R2_BUCKET ?? config.vars?.R2_BUCKET,
						R2_ACCESS_KEY_ID:
							process.env.R2_ACCESS_KEY_ID ?? config.vars?.R2_ACCESS_KEY_ID,
						R2_SECRET_ACCESS_KEY:
							process.env.R2_SECRET_ACCESS_KEY ??
							config.vars?.R2_SECRET_ACCESS_KEY,
						R2_REGION: process.env.R2_REGION ?? config.vars?.R2_REGION,
						S3_PREFIX: process.env.S3_PREFIX ?? config.vars?.S3_PREFIX,
						S3_ALLOW_HTTP:
							process.env.S3_ALLOW_HTTP ?? config.vars?.S3_ALLOW_HTTP,
						SUPABASE_JWKS_URL:
							process.env.SUPABASE_JWKS_URL ?? config.vars?.SUPABASE_JWKS_URL,
						SUPABASE_JWT_ISSUER_URL:
							process.env.SUPABASE_JWT_ISSUER_URL ??
							config.vars?.SUPABASE_JWT_ISSUER_URL,
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
						...posthogVars,
					},
				};
			},
		}),
		tailwindcss(),
		tanstackStart(),
		react(),
		...posthogSourceMapPlugins(command),
	],
}));
