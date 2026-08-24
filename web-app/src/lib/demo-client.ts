const runtimeDemoMode =
	typeof document !== "undefined" &&
	document
		.querySelector('meta[name="lixray-demo"]')
		?.getAttribute("content") === "1";

export const isDemoModeEnabled =
	import.meta.env.VITE_LIXRAY_DEMO === "1" || runtimeDemoMode;
