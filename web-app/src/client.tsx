import { RouterProvider } from "@tanstack/react-router";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { isDemoModeEnabled } from "./lib/demo-client";
import { getRouter } from "./router";

if (isDemoModeEnabled) {
	const router = getRouter();
	void router.load().then(() => {
		startTransition(() => {
			createRoot(document).render(
				<StrictMode>
					<RouterProvider router={router} />
				</StrictMode>,
			);
		});
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
