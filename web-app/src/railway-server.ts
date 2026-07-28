import startHandler from "@tanstack/react-start/server-entry";
import { parseSqlScript as parseWorkerdSqlScript } from "@lix-js/sdk/workerd";
import { addGoogleAnalytics } from "./lib/google-analytics";
import { parseSqlScript as parseNodeSqlScript } from "./lib/node-lix-sql-parser";
import { withShareSecurityHeaders } from "./lib/share-security";
import { handleRequest, type WorkerEnv } from "./worker/handler";

const parseSqlScript = import.meta.env.DEV
	? parseWorkerdSqlScript
	: parseNodeSqlScript;

export default {
	async fetch(
		request: Request,
		env: WorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		ctx.passThroughOnException();
		return handleRequest(request, env, {
			executionContext: ctx,
			parseSqlScript,
			lixFetch: (lixId, lixRequest) => fetchLixService(env, lixId, lixRequest),
			fallback: async (fallbackRequest) => {
				const response = await startHandler.fetch(fallbackRequest);
				return withShareSecurityHeaders(
					await addGoogleAnalytics(
						fallbackRequest,
						response,
						env.GOOGLE_ANALYTICS_ID,
					),
				);
			},
		});
	},
};

export async function fetchLixService(
	env: WorkerEnv,
	lixId: string,
	request: Request,
): Promise<Response> {
	const serviceUrl =
		env.LIXRAY_LIX_SERVICE_URL ?? env.LIXRAY_WORKSPACE_SERVICE_URL;
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

	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${env.LIXRAY_INTERNAL_TOKEN}`);
	return fetch(new Request(targetUrl, request), { headers });
}
