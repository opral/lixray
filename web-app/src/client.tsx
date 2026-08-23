import { RouterProvider } from "@tanstack/react-router";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { initializeBrowserAssetCache } from "./lib/browser-asset-cache";
import { isDemoModeEnabled } from "./lib/demo-client";
import { getRouter } from "./router";

async function startClient() {
	if (import.meta.env.PROD) {
		await initializeBrowserAssetCache().catch((error: unknown) => {
			console.warn("Could not initialize the browser asset cache", error);
		});
	}

	if (isDemoModeEnabled) {
		const router = getRouter();
		await router.load();
		startTransition(() => {
			createRoot(document).render(
				<StrictMode>
					<RouterProvider router={router} />
				</StrictMode>,
			);
		});
	} else {
		startTransition(() => {
			hydrateRoot(
				document,
				<StrictMode>
					<StartClient />
				</StrictMode>,
			);
		});
	}
}

void startClient();
