import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const repository = resolve(root, "../../..");
const manifestPath = process.env.LIXRAY_MIGRATION_FIXTURE;
const oldProvider = process.env.LIXRAY_MIGRATION_OLD_OPFS;
const candidateSdk = process.env.LIXRAY_MIGRATION_SDK;
const candidateAliases = candidateSdk
	? Object.entries(
			JSON.parse(readFileSync(resolve(candidateSdk, "package.json"), "utf8"))
				.exports,
		).map(([subpath, entry]) => {
			const specifier =
				subpath === "." ? "@lix-js/sdk" : `@lix-js/sdk${subpath.slice(1)}`;
			return {
				find: new RegExp(
					`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
				),
				replacement: resolve(candidateSdk, entry.default),
			};
		})
	: [];
if (!manifestPath || !oldProvider)
	throw new Error(
		"Set LIXRAY_MIGRATION_FIXTURE and LIXRAY_MIGRATION_OLD_OPFS; see README.md",
	);
const manifest = readFileSync(manifestPath, "utf8");
const authority = new URL(JSON.parse(manifest).url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname))
	throw new Error("Migration QA requires a disposable loopback authority");
export default {
	root,
	define: {
		__OLD_OPFS_MODULE__: JSON.stringify(
			`/@fs/${resolve(oldProvider, "dist/index.js")}`,
		),
	},
	resolve: {
		alias: [
			{
				find: /^@lix-js\/storage-opfs$/,
				replacement: resolve(root, "storage.mjs"),
			},
			...candidateAliases,
		],
	},
	worker: { format: "es" },
	optimizeDeps: {
		noDiscovery: true,
		include: [
			"protobufjs/light.js",
			"react",
			"react-dom/client",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
		],
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.LIXRAY_MIGRATION_PORT ?? 8796),
		fs: {
			allow: [
				repository,
				resolve(repository, ".."),
				resolve(oldProvider),
				...(candidateSdk ? [resolve(candidateSdk)] : []),
			],
		},
		proxy: { "/lix/": { target: authority.origin, changeOrigin: true } },
	},
	plugins: [
		{
			name: "synthetic-migration-fixture",
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url !== "/__fixture.json") return next();
					response.setHeader("content-type", "application/json");
					response.end(manifest);
				});
			},
		},
	],
};
