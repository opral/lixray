import startHandler from "@tanstack/react-start/server-entry";
import { handleRequest, type WorkerEnv } from "./worker/handler";

export default {
	async fetch(
		request: Request,
		env: WorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		ctx.passThroughOnException();
		return handleRequest(request, env, {
			executionContext: ctx,
			workspaceFetch: (workspaceId, workspaceRequest) =>
				fetchWorkspaceService(env, workspaceId, workspaceRequest),
			fallback: async (fallbackRequest) =>
				await startHandler.fetch(fallbackRequest),
		});
	},
};

export async function fetchWorkspaceService(
	env: WorkerEnv,
	workspaceId: string,
	request: Request,
): Promise<Response> {
	if (!env.LIXRAY_WORKSPACE_SERVICE_URL) {
		return new Response("LIXRAY_WORKSPACE_SERVICE_URL is not configured\n", {
			status: 500,
		});
	}
	if (!env.LIXRAY_INTERNAL_TOKEN) {
		return new Response("LIXRAY_INTERNAL_TOKEN is not configured\n", {
			status: 500,
		});
	}

	const sourceUrl = new URL(request.url);
	const targetUrl = new URL(env.LIXRAY_WORKSPACE_SERVICE_URL);
	targetUrl.pathname = `/workspaces/${encodeURIComponent(workspaceId)}${sourceUrl.pathname}`;
	targetUrl.search = sourceUrl.search;

	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${env.LIXRAY_INTERNAL_TOKEN}`);
	return fetch(new Request(targetUrl, request), { headers });
}
