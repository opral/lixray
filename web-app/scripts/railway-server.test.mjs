import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import vm from "node:vm";
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
	assert.equal(
		response.headers.get("cache-control"),
		"public, max-age=0, must-revalidate",
	);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wasm);
});

test("caches fingerprinted build assets immutably", async () => {
	const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
	const response = await withServer(
		async () => new Response("unused"),
		(origin) => fetch(`${origin}/assets/lix_js_sdk_bg-DqSFzV-L.wasm`),
		{},
		async (clientRoot) => {
			await mkdir(join(clientRoot, "assets"));
			await writeFile(
				join(clientRoot, "assets/lix_js_sdk_bg-DqSFzV-L.wasm"),
				wasm,
			);
		},
	);
	assert.equal(response.headers.get("content-type"), "application/wasm");
	assert.equal(
		response.headers.get("cache-control"),
		"public, max-age=31536000, immutable",
	);
});

test("does not cache an unfingerprinted build asset immutably", async () => {
	const response = await withServer(
		async () => new Response("unused"),
		(origin) => fetch(`${origin}/assets/lix_js_sdk_bg.wasm`),
		{},
		async (clientRoot) => {
			await mkdir(join(clientRoot, "assets"));
			await writeFile(
				join(clientRoot, "assets/lix_js_sdk_bg.wasm"),
				new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
			);
		},
	);
	assert.equal(
		response.headers.get("cache-control"),
		"public, max-age=0, must-revalidate",
	);
});

test("revalidates the asset-cache service worker", async () => {
	const response = await withServer(
		async () => new Response("unused"),
		(origin) => fetch(`${origin}/lixray-asset-cache-sw.js`),
		{},
		(clientRoot) =>
			writeFile(
				join(clientRoot, "lixray-asset-cache-sw.js"),
				"self.addEventListener('fetch', () => undefined);",
			),
	);
	assert.equal(
		response.headers.get("cache-control"),
		"public, max-age=0, must-revalidate",
	);
});

test("the asset-cache worker isolates Lix versions by Wasm fingerprint", async () => {
	const source = await readFile(
		new URL("../public/lixray-asset-cache-sw.js", import.meta.url),
		"utf8",
	);
	const listeners = new Map();
	const entries = new Map();
	let networkRequests = 0;
	let contentType = "application/wasm; charset=binary";
	const cache = {
		async delete(request) {
			return entries.delete(request.url);
		},
		async keys() {
			return [...entries.values()].map((entry) => entry.request);
		},
		async match(request) {
			return entries.get(request.url)?.response.clone();
		},
		async put(request, response) {
			entries.set(request.url, {
				request,
				response: response.clone(),
			});
		},
	};
	const context = {
		Request,
		Response,
		URL,
		caches: { open: async () => cache },
		fetch: async () => {
			networkRequests += 1;
			return new Response(`wasm-${networkRequests}`, {
				headers: { "content-type": contentType },
			});
		},
		self: {
			addEventListener: (name, listener) => listeners.set(name, listener),
			clients: { claim: async () => undefined },
			location: { origin: "https://lixray.example" },
			skipWaiting: async () => undefined,
		},
	};
	vm.runInNewContext(source, context);

	async function dispatch(path) {
		let responsePromise;
		listeners.get("fetch")({
			request: new Request(`https://lixray.example${path}`),
			respondWith: (response) => {
				responsePromise = Promise.resolve(response);
			},
		});
		return responsePromise;
	}

	const firstUrl = "/assets/lix_js_sdk_bg-DqSFzV-L.wasm";
	assert.equal(await (await dispatch(firstUrl)).text(), "wasm-1");
	assert.equal(await (await dispatch(firstUrl)).text(), "wasm-1");
	assert.equal(networkRequests, 1);

	const nextVersionUrl = "/assets/lix_js_sdk_bg-X7abc123.wasm";
	assert.equal(await (await dispatch(nextVersionUrl)).text(), "wasm-2");
	assert.equal(networkRequests, 2);

	assert.equal(await dispatch("/assets/lix_js_sdk_bg.wasm"), undefined);
	assert.equal(
		await dispatch(`${firstUrl}?not-the-fingerprinted-resource=1`),
		undefined,
	);
	assert.equal(networkRequests, 2);

	contentType = "text/html";
	const invalidUrl = "/assets/lix_js_sdk_bg-BadMime1.wasm";
	await dispatch(invalidUrl);
	await dispatch(invalidUrl);
	assert.equal(networkRequests, 4);
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
		assert.equal(response.headers.get("cache-control"), "private, no-cache");
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
	assert.equal(response.headers.get("cache-control"), "private, no-cache");
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
	assert.equal(response.headers.get("cache-control"), "private, no-cache");
});

test("preserves no-store on sensitive rendered HTML", async () => {
	const response = await withServer(
		async () =>
			new Response("<html><body>private</body></html>", {
				headers: {
					"cache-control": "private, no-store",
					"content-type": "text/html; charset=utf-8",
				},
			}),
		(origin) => fetch(`${origin}/account`),
	);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
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
