const GOOGLE_ANALYTICS_ID_PATTERN = /^G-[A-Z0-9]+$/;
const GOOGLE_ANALYTICS_SCRIPT_ID = "lixray-google-analytics";

export async function addGoogleAnalytics(
	request: Request,
	response: Response,
	measurementId: string | undefined,
): Promise<Response> {
	const normalizedId = measurementId?.trim();
	if (
		request.method !== "GET" ||
		new URL(request.url).pathname !== "/" ||
		!normalizedId ||
		!GOOGLE_ANALYTICS_ID_PATTERN.test(normalizedId) ||
		!response.headers.get("content-type")?.includes("text/html") ||
		response.headers.has("content-encoding")
	) {
		return response;
	}

	const html = await response.text();
	if (
		!html.includes("</head>") ||
		html.includes(`id="${GOOGLE_ANALYTICS_SCRIPT_ID}"`)
	) {
		return responseWithBody(response, html);
	}

	return responseWithBody(
		response,
		html.replace("</head>", `${googleAnalyticsTag(normalizedId)}</head>`),
	);
}

function googleAnalyticsTag(measurementId: string): string {
	const id = JSON.stringify(measurementId);
	return `<script id="${GOOGLE_ANALYTICS_SCRIPT_ID}" async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date);gtag("config",${id},{allow_google_signals:false,allow_ad_personalization_signals:false});</script>`;
}

function responseWithBody(response: Response, body: string): Response {
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
