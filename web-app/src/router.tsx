import { createBrowserHistory, createRouter } from "@tanstack/react-router";
import { isDemoModeEnabled } from "./lib/demo-client";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	return createRouter({
		history:
			typeof window !== "undefined" && isDemoModeEnabled
				? createBrowserHistory({
						parseLocation: () => {
							const rawState: unknown = window.history.state;
							const state =
								typeof rawState === "object" && rawState !== null
									? rawState
									: {};
							const pathname = window.location.pathname.replace(
								/^\/%40/i,
								"/@",
							);
							const { hash, search } = window.location;
							return {
								hash,
								href: `${pathname}${search}${hash}`,
								pathname,
								search,
								state: {
									...state,
									__TSR_index:
										"__TSR_index" in state &&
										typeof state.__TSR_index === "number"
											? state.__TSR_index
											: 0,
								},
							};
						},
					})
				: undefined,
		routeTree,
		// Inside a repository the Atelier shell owns every scroll position.
		// The router's restoration copies the previous URL's element offsets
		// onto the next one, which scrolled the tab strip back off the tab
		// that had just opened.
		scrollRestoration: ({ location }) => !location.pathname.startsWith("/@"),
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
