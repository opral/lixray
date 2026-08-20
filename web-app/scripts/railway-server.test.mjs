import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createRailwayServer } from "./railway-server.mjs";

async function withServer(appFetch, run, env = {}, prepare = async () => {}) {
	const clientRoot = await mkdtemp(join(tmpdir(), "railway-server-"));
	await prepare(clientRoot);
	const server = createRailwayServer({
		app: { fetch: appFetch },
		clientRoot,
		env,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test("serves WebAssembly with its streaming compilation MIME type", async () => {
	const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
	const response = await withServer(
		async () => new Response("unused"),
		(origin) => fetch(`${origin}/lix.wasm`),
		{},
		(clientRoot) => writeFile(join(clientRoot, "lix.wasm"), wasm),
	);
	assert.equal(response.headers.get("content-type"), "application/wasm");
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wasm);
});

test("injects preview mode into static HTML at runtime", async () => {
	const clientRoot = await mkdtemp(join(tmpdir(), "railway-server-static-"));
	await writeFile(
		clientRoot + "/index.html",
		"<html><head></head><body></body></html>",
	);
	const server = createRailwayServer({
		app: { fetch: () => new Response("unused") },
		clientRoot,
		env: { RAILWAY_ENVIRONMENT_NAME: "lixray-pr-216" },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		assert.match(
			await response.text(),
			/<meta name="lixray-demo" content="1">/,
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("injects preview mode into rendered HTML at runtime", async () => {
	const response = await withServer(
		async () =>
			new Response("<html><head></head><body>rendered</body></html>", {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		(origin) => fetch(`${origin}/sign-in`),
		{ LIXRAY_DEMO: "1" },
	);
	assert.match(await response.text(), /<meta name="lixray-demo" content="1">/);
});

test("does not inject preview mode in production", async () => {
	const response = await withServer(
		async () =>
			new Response("<html><head></head><body>rendered</body></html>", {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		(origin) => fetch(`${origin}/sign-in`),
		{ RAILWAY_ENVIRONMENT_NAME: "production" },
	);
	assert.doesNotMatch(await response.text(), /lixray-demo/);
});

test("proxies a streaming response through", async () => {
	const response = await withServer(
		async () => new Response("hello from the app\n", { status: 200 }),
		(origin) => fetch(`${origin}/anything`),
	);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "hello from the app\n");
});

test("answers 502 when the upstream fetch fails", async () => {
	const response = await withServer(
		async () => {
			throw new TypeError("fetch failed", {
				cause: new Error("Headers Timeout Error"),
			});
		},
		(origin) => fetch(`${origin}/lix/v1/`),
	);
	assert.equal(response.status, 502);
	assert.match(await response.text(), /Upstream service unavailable/);
});

test("client disconnect aborts a held application request", async () => {
	let requestReachedApp;
	const reachedApp = new Promise((resolve) => {
		requestReachedApp = resolve;
	});
	let requestAborted;
	const appSawAbort = new Promise((resolve) => {
		requestAborted = resolve;
	});

	await withServer(
		async (request) => {
			requestReachedApp();
			await new Promise((resolve) => {
				request.signal.addEventListener(
					"abort",
					() => {
						requestAborted();
						resolve();
					},
					{ once: true },
				);
			});
			return new Response("cancelled");
		},
		async (origin) => {
			const clientRequest = httpRequest(`${origin}/held`);
			clientRequest.on("error", () => undefined);
			clientRequest.end();
			await reachedApp;
			clientRequest.destroy();
			await Promise.race([
				appSawAbort,
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("disconnect did not abort app request")),
						1_000,
					),
				),
			]);
		},
	);
});

test("a response body erroring mid-stream does not crash the process", async () => {
	const result = await withServer(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("partial"));
					},
					pull(controller) {
						controller.error(new Error("upstream connection wedged"));
					},
				}),
				{ status: 200 },
			),
		// The request may fail at fetch time or while reading the body,
		// depending on how far the stream got before the abort — both mean
		// the connection ended instead of hanging, and the 'error' listener
		// kept the event from killing the process (an uncaught stream error
		// would take down this whole test run).
		(origin) =>
			fetch(`${origin}/lix/v1/`)
				.then((response) => response.text())
				.then(
					() => "completed",
					() => "aborted",
				),
	);
	assert.ok(result === "aborted" || result === "completed");
});
