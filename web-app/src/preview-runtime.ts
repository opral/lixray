import { openMemoryLix } from "@lix-js/sdk/workerd";
import { handleRequest, type WorkerEnv } from "./worker/handler";
import { createMemoryWorkspaceBackend } from "./worker/memory-backend";

const workspaceBackend = createMemoryWorkspaceBackend(openMemoryLix);

export default {
	async fetch(
		request: Request,
		env: WorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		ctx.passThroughOnException();
		return handleRequest(request, env, {
			executionContext: ctx,
			workspaceFetch: workspaceBackend.fetch,
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
