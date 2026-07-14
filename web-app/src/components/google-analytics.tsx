import { useEffect } from "react";

declare global {
	interface Window {
		dataLayer?: unknown[];
		gtag?: (...args: unknown[]) => void;
	}
}

const GOOGLE_TAG_SCRIPT_ID = "lixray-google-analytics";

export function GoogleAnalytics() {
	useEffect(() => {
		const measurementId =
			import.meta.env.VITE_PUBLIC_GOOGLE_ANALYTICS_ID?.trim();
		if (!measurementId) return;

		window.dataLayer ??= [];
		window.gtag ??= (...args: unknown[]) => {
			window.dataLayer?.push(args);
		};
		window.gtag("js", new Date());
		window.gtag("config", measurementId, {
			allow_google_signals: false,
			allow_ad_personalization_signals: false,
		});

		if (document.getElementById(GOOGLE_TAG_SCRIPT_ID)) return;
		const script = document.createElement("script");
		script.id = GOOGLE_TAG_SCRIPT_ID;
		script.async = true;
		script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
		document.head.appendChild(script);
	}, []);

	return null;
}
