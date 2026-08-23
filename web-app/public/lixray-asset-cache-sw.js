const LIX_WASM_CACHE = "lixray-lix-wasm-v1";
const FINGERPRINTED_LIX_WASM =
	/^\/assets\/lix_js_sdk_bg-[A-Za-z0-9_-]{8}\.wasm$/;

self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (
		request.method !== "GET" ||
		request.headers.has("range") ||
		url.origin !== self.location.origin ||
		url.search !== "" ||
		!FINGERPRINTED_LIX_WASM.test(url.pathname)
	) {
		return;
	}

	event.respondWith(
		(async () => {
			let cache;
			try {
				cache = await caches.open(LIX_WASM_CACHE);
				const cached = await cache.match(request);
				if (cached && isUsableWasm(cached)) return cached;
				if (cached) await cache.delete(request);
			} catch {
				// CacheStorage is an optimization. A quota or browser-policy failure
				// must never prevent Lix from falling back to the network.
			}

			const response = await fetch(request);
			if (cache && isUsableWasm(response)) {
				try {
					await cache.put(request, response.clone());
					await pruneOldWasm(cache, 3);
				} catch {
					// Return the successful network response even when persistence fails.
				}
			}
			return response;
		})(),
	);
});

function isUsableWasm(response) {
	return (
		response.status === 200 &&
		!response.redirected &&
		response.headers.get("content-type")?.split(";", 1)[0].trim() ===
			"application/wasm"
	);
}

async function pruneOldWasm(cache, retainedCount) {
	const wasmRequests = (await cache.keys()).filter((request) => {
		const url = new URL(request.url);
		return (
			url.origin === self.location.origin &&
			FINGERPRINTED_LIX_WASM.test(url.pathname)
		);
	});
	for (const request of wasmRequests.slice(0, -retainedCount)) {
		await cache.delete(request);
	}
}
