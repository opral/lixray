import posthogRollupPlugin from "@posthog/rollup-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const webAppDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(webAppDir, "..");
const atelierSourceDir = path.resolve(repositoryRoot, "vendor/atelier/src");

function devHealthcheckPlugin(): Plugin {
	return {
		name: "lixray-dev-healthcheck",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = request.url?.split("?", 1)[0];
				if (request.method !== "GET" || pathname !== "/healthz") {
					next();
					return;
				}
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ status: "ok" }));
			});
		},
	};
}

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
	// The SDK Component host loads modules asynchronously inside its workers.
	worker: { format: "es" },
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
		// The Codex/browser preview tunnels the Vite origin, but not arbitrary
		// localhost ports. Proxy local Supabase through that same origin so the
		// browser and the server resolve repository metadata from one stack.
		proxy:
			command === "serve"
				? {
						"/auth": {
							target: "http://127.0.0.1:54321",
							changeOrigin: true,
						},
						"/rest": {
							target: "http://127.0.0.1:54321",
							changeOrigin: true,
						},
						"/storage": {
							target: "http://127.0.0.1:54321",
							changeOrigin: true,
						},
						"/realtime": {
							target: "http://127.0.0.1:54321",
							changeOrigin: true,
							ws: true,
						},
						"/functions": {
							target: "http://127.0.0.1:54321",
							changeOrigin: true,
						},
						"/graphql": {
							target: "http://127.0.0.1:54321",
							changeOrigin: true,
						},
					}
				: undefined,
	},
	optimizeDeps: {
		// Linked workspace routes and lazy repository views are not HTML entries.
		// Scan them before serving the first browser page.
		entries:
			command === "serve"
				? ["src/routes/**/*.{ts,tsx}", "src/components/repository-atelier.tsx"]
				: undefined,
		// Snapshot sessions are intentionally lost on reload. Pre-bundle the
		// linked Atelier editors before first use so dependency discovery cannot
		// trigger an "optimized dependencies changed" reload after opening one.
		include:
			command === "serve"
				? [
						"sonner",
						"clsx",
						"tailwind-merge",
						"lucide-react",
						"jose",
						"@supabase/supabase-js",
						"class-variance-authority",
						"radix-ui",
						"fflate",
						"marked",
						"react-aria-components",
						"@opral/atelier > @tiptap/pm/schema-list",
						"@opral/atelier > @tiptap/pm/model",
						"@opral/atelier > roughjs",
						"@opral/atelier > perfect-freehand",
						"@opral/atelier > @dnd-kit/core",
						"@opral/atelier > @dnd-kit/sortable",
						"@opral/atelier > @dnd-kit/utilities",
						"@opral/atelier > @base-ui/react/popover",
						"@opral/atelier > @base-ui/react/select",
						"@opral/atelier > @base-ui/react/toolbar",
						"@opral/atelier > @base-ui/react/tooltip",
						"@opral/atelier > @codemirror/autocomplete",
						"@opral/atelier > @codemirror/commands",
						"@opral/atelier > @codemirror/lang-css",
						"@opral/atelier > @codemirror/lang-javascript",
						"@opral/atelier > @codemirror/lang-json",
						"@opral/atelier > @codemirror/lang-python",
						"@opral/atelier > @codemirror/lang-sql",
						"@opral/atelier > @codemirror/language",
						"@opral/atelier > @codemirror/search",
						"@opral/atelier > @codemirror/state",
						"@opral/atelier > @codemirror/view",
						"@opral/atelier > @glideapps/glide-data-grid",
						"@opral/atelier > @lezer/highlight",
						"@opral/atelier > @lix-js/html-diff",
						"@opral/atelier > @pierre/trees/react",
						"@opral/atelier > @radix-ui/react-context-menu",
						"@opral/atelier > @radix-ui/react-dropdown-menu",
						"@opral/atelier > @radix-ui/react-tooltip",
						"@opral/atelier > @tiptap/core",
						"@opral/atelier > @tiptap/extension-history",
						"@opral/atelier > @tiptap/extension-placeholder",
						"@opral/atelier > @tiptap/pm/commands",
						"@opral/atelier > @tiptap/pm/dropcursor",
						"@opral/atelier > @tiptap/pm/history",
						"@opral/atelier > @tiptap/pm/state",
						"@opral/atelier > @tiptap/pm/view",
						"@opral/atelier > @tiptap/react",
						"@opral/atelier > kysely",
						"@opral/atelier > mdast-util-from-markdown",
						"@opral/atelier > mdast-util-frontmatter",
						"@opral/atelier > mdast-util-gfm",
						"@opral/atelier > mdast-util-to-markdown",
						"@opral/atelier > mermaid",
						"@opral/atelier > micromark-extension-frontmatter",
						"@opral/atelier > micromark-extension-gfm",
						"@opral/atelier > papaparse",
						"@opral/atelier > pdfjs-dist",
						"@opral/atelier > react-resizable-panels",
						"@opral/atelier > yaml",
					]
				: [],
		// The Lix worker is lazy-loaded after workspace navigation. Keep its
		// ESM shims out of the optimizer so first use cannot reload the page.
		exclude:
			command === "serve"
				? ["@opral/atelier", "@bytecodealliance/preview2-shim"]
				: [],
	},
	plugins: [
		devHealthcheckPlugin(),
		tailwindcss(),
		tanstackStart({
			server: {
				entry: "railway-server.ts",
			},
		}),
		react(),
		...posthogSourceMapPlugins(command),
	],
}));
