const ASSET_CACHE_SERVICE_WORKER_URL = "/lixray-asset-cache-sw.js";

/**
 * Installs the durable cache for Lix's fingerprinted browser runtime before the
 * first repository is opened. Existing installations already control the new
 * document, so returning users do not wait for a service-worker update check.
 */
export async function initializeBrowserAssetCache(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;

	const existing = await navigator.serviceWorker.getRegistration("/");
	if (existing?.active && navigator.serviceWorker.controller) {
		// Pick up cache-worker changes without putting the update check on the
		// repository-open critical path.
		void navigator.serviceWorker
			.register(ASSET_CACHE_SERVICE_WORKER_URL, {
				scope: "/",
				updateViaCache: "none",
			})
			.catch(() => undefined);
		return;
	}

	const controlled = waitForController(2_000);
	await Promise.race([
		navigator.serviceWorker
			.register(ASSET_CACHE_SERVICE_WORKER_URL, {
				scope: "/",
				updateViaCache: "none",
			})
			.then(() => controlled),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
}

function waitForController(timeoutMs: number): Promise<void> {
	if (navigator.serviceWorker.controller) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timeout);
			navigator.serviceWorker.removeEventListener("controllerchange", finish);
			resolve();
		};
		const timeout = setTimeout(finish, timeoutMs);
		navigator.serviceWorker.addEventListener("controllerchange", finish);
	});
}
