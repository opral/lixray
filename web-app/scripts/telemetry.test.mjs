import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { trace } from "@opentelemetry/api";
import { initializeTelemetry } from "./telemetry.mjs";
import { createRailwayServer } from "./railway-server.mjs";
import { listenOnFetchSafePort } from "./test-http-listen.mjs";

test(
	"a hanging OTLP exporter is bounded and cannot hold HTTP responses",
	{ timeout: 15000 },
	async () => {
		const received = Promise.withResolvers();
		let collectorRequests = 0;
		const collector = createServer((request, response) => {
			collectorRequests++;
			assert.equal(request.url, "/i/v1/traces");
			assert.equal(request.headers.authorization, "Bearer test-token");
			assert.equal(request.headers["content-type"], "application/x-protobuf");
			request.resume();
			// First export hangs; later exports succeed so shutdown can drain.
			if (collectorRequests === 1) received.resolve();
			else response.end();
		});
		await listenOnFetchSafePort(collector);
		const provider = initializeTelemetry({
			POSTHOG_ENVIRONMENT: "production",
			POSTHOG_PROJECT_TOKEN: "test-token",
			POSTHOG_HOST: `http://127.0.0.1:${collector.address().port}`,
			LIXRAY_RELEASE_ID: "test-revision",
		});
		const server = createRailwayServer({
			app: {
				async fetch() {
					assert.ok(trace.getActiveSpan());
					return new Response("ok");
				},
			},
			clientRoot: "/nonexistent",
			env: {},
		});
		await listenOnFetchSafePort(server);
		try {
			const url = `http://127.0.0.1:${server.address().port}/mcp`;
			assert.equal(await (await fetch(url)).text(), "ok");
			let flushed = false;
			const pending = provider
				.forceFlush()
				.catch(() => undefined)
				.finally(() => {
					flushed = true;
				});
			await received.promise;
			assert.equal(await (await fetch(url)).text(), "ok");
			assert.equal(
				flushed,
				false,
				"response must finish while the exporter is still held",
			);
			await pending; // The configured exporter timeout, not the HTTP request, ends the hang.
			assert.equal(flushed, true);
		} finally {
			await provider.shutdown();
			server.closeAllConnections();
			collector.closeAllConnections();
			await Promise.all([
				new Promise((resolve) => server.close(resolve)),
				new Promise((resolve) => collector.close(resolve)),
			]);
		}
	},
);
