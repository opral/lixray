import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The runtime image bundles this helper separately because it has no
// node_modules. Install the patched Fetch implementation before telemetry or
// the app imports can capture Node's bundled fetch classes.
await import("./undici-runtime.mjs");
await import("./assert-railway-env.mjs");
const [{ initializeTelemetry }, { createRailwayServer }] = await Promise.all([
	import("./telemetry.mjs"),
	import("./railway-server.mjs"),
]);
const telemetry = initializeTelemetry();
const { default: app } = await import("../dist/server/railway-server.js");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = resolve(root, "dist/client");
const port = Number(process.env.PORT ?? 8080);

process.env.LIXRAY_JWKS_CACHE_PATH ??= join(tmpdir(), "lixray-jwks-cache.json");

try {
	await app.warmJwtVerifier(process.env);
} catch (error) {
	console.warn(
		"LixRay JWKS warmup failed; MCP will 503 until JWKS is reachable",
		error,
	);
}

const server = createRailwayServer({ app, clientRoot });

server.listen(port, "0.0.0.0", () => {
	console.log(`LixRay web service ready on 0.0.0.0:${port}`);
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		// Drain admitted requests before flushing their completed spans. Bound
		// shutdown so a long-lived SSE connection cannot prevent termination.
		const deadline = setTimeout(() => {
			server.closeAllConnections();
		}, 10_000);
		server.close(async () => {
			clearTimeout(deadline);
			try {
				await telemetry.shutdown();
			} catch {
				console.warn("Telemetry shutdown failed");
			}
		});
	});
}
