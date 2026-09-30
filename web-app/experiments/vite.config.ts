import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const proxy = {
	"/lix/": {
		target: "http://127.0.0.1:18309",
		changeOrigin: true,
		headers: {
			Authorization: "Bearer lixray-local-internal-token",
			"x-lix-account-id": "00000000-0000-4000-8000-000000000031",
			"x-lix-idempotency-scope": "prototype:account",
		},
	},
};
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	worker: { format: "es" },
	build: {
		outDir: "../.architecture/dist",
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL("architecture.html", import.meta.url)),
		},
	},
	plugins: [
		{
			name: "prototype-cacheable-assets",
			configurePreviewServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url?.startsWith("/assets/"))
						response.setHeader(
							"Cache-Control",
							"public, max-age=31536000, immutable",
						);
					next();
				});
			},
		},
	],
	preview: { host: "127.0.0.1", port: 8830, strictPort: true, proxy },
	server: {
		host: "127.0.0.1",
		port: 8830,
		strictPort: true,
		fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
		proxy,
	},
});
