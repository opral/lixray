import { openMemoryLix } from "@lix-js/sdk/workerd";
import startHandler from "@tanstack/react-start/server-entry";
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
		return handleRequest(request, env, {
			executionContext: ctx,
			workspaceFetch: (workspaceId, workspaceRequest) =>
				workspaceBackend.fetch(
					env.PREVIEW_STATE,
					workspaceId,
					workspaceRequest,
				),
			fallback: async (fallbackRequest) =>
				await startHandler.fetch(fallbackRequest),
		});
	},
};
