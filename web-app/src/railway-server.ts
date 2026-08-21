import process from "node:process";
import startHandler from "@tanstack/react-start/server-entry";
import { addGoogleAnalytics } from "./lib/google-analytics";
import { lixServiceRequestHeaders } from "./lib/lix-service-proxy";
import { withShareSecurityHeaders } from "./lib/share-security";
import {
	handleRequest,
	warmJwtVerifier,
	type RequestExecutionContext,
	type WorkerEnv,
} from "./worker/handler";

export { warmJwtVerifier };

export default {
	async fetch(
		request: Request,
		env?: WorkerEnv,
		ctx?: RequestExecutionContext,
	): Promise<Response> {
		const runtimeEnv = env ?? (process.env as WorkerEnv);
		ctx?.passThroughOnException();
		return handleRequest(request, runtimeEnv, {
			executionContext: ctx,
			lixFetch: (lixId, lixRequest) =>
				fetchLixService(runtimeEnv, lixId, lixRequest),
			fallback: async (fallbackRequest) => {
				const response = await startHandler.fetch(fallbackRequest);
				return withShareSecurityHeaders(
					await addGoogleAnalytics(
						fallbackRequest,
						response,
						runtimeEnv.GOOGLE_ANALYTICS_ID,
					),
				);
			},
		});
	},
	warmJwtVerifier,
};

export async function fetchLixService(
	env: WorkerEnv,
	lixId: string,
	request: Request,
): Promise<Response> {
	const serviceUrl =
		env.LIXRAY_LIX_SERVICE_URL ??
		env.LIXRAY_REPOSITORY_SERVICE_URL ??
		env.LIXRAY_WORKSPACE_SERVICE_URL;
	if (!serviceUrl) {
		return new Response("LIXRAY_LIX_SERVICE_URL is not configured\n", {
			status: 500,
		});
	}
	if (!env.LIXRAY_INTERNAL_TOKEN) {
		return new Response("LIXRAY_INTERNAL_TOKEN is not configured\n", {
			status: 500,
		});
	}

	const sourceUrl = new URL(request.url);
	const targetUrl = new URL(serviceUrl);
	targetUrl.pathname = `/lixes/${encodeURIComponent(lixId)}${sourceUrl.pathname}`;
	targetUrl.search = sourceUrl.search;

	const headers = lixServiceRequestHeaders(
		request.headers,
		env.LIXRAY_INTERNAL_TOKEN,
	);
	return fetch(new Request(targetUrl, request), { headers });
}
