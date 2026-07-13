import { openMemoryLix } from "@lix-js/sdk/workerd";
import { DEMO_MAIN_BRANCH_ID } from "./lib/demo-identity";
import { handleRequest, type PreviewWorkerEnv } from "./worker/handler";
import { createR2WorkspaceBackend } from "./worker/memory-backend";

const workspaceBackend = createR2WorkspaceBackend(openMemoryLix, {
	mainBranchId: DEMO_MAIN_BRANCH_ID,
});

export default {
	async fetch(
		request: Request,
		env: PreviewWorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		ctx.passThroughOnException();
		const previewHostname = new URL(request.url).hostname;
		return handleRequest(request, env, {
			executionContext: ctx,
			workspaceFetch: (workspaceId, workspaceRequest) =>
				workspaceBackend.fetch(
					env.PREVIEW_STATE,
					previewHostname,
					workspaceId,
					workspaceRequest,
				),
			fallback: async (fallbackRequest, fallbackEnv) => {
				if (!fallbackEnv.ASSETS) {
					return new Response("Not found\n", { status: 404 });
				}
				if (
					fallbackRequest.method === "GET" &&
					fallbackRequest.headers.get("accept")?.includes("text/html")
				) {
					const shellUrl = new URL(fallbackRequest.url);
					shellUrl.pathname = "/";
					return fallbackEnv.ASSETS.fetch(
						new Request(shellUrl, fallbackRequest),
					);
				}
				return fallbackEnv.ASSETS.fetch(fallbackRequest);
			},
		});
	},
};
