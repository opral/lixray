import { createBrowserHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	return createRouter({
		history:
			typeof window !== "undefined" && import.meta.env.VITE_LIXRAY_DEMO === "1"
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
		scrollRestoration: true,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
