import { openMemoryLix } from "@lix-js/sdk/workerd";
import startHandler from "@tanstack/react-start/server-entry";
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
			fallback: async (fallbackRequest) =>
				await startHandler.fetch(fallbackRequest),
		});
	},
};
