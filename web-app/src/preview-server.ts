import { openMemoryLix, parseSqlScript } from "@lix-js/sdk/workerd";
import startHandler from "@tanstack/react-start/server-entry";
import { DEMO_MAIN_BRANCH_ID } from "./lib/demo-identity";
import { withShareSecurityHeaders } from "./lib/share-security";
import { handleRequest, type PreviewWorkerEnv } from "./worker/handler";
import {
	authenticatePreviewDemoBrowser,
	authenticatePreviewDemoMcp,
	authorizePreviewDemoWorkspace,
	handlePreviewShareRequest,
} from "./worker/preview-share-service";
import { createR2WorkspaceRuntime } from "./worker/workspace-runtime";

const workspaceRuntime = createR2WorkspaceRuntime(openMemoryLix, {
	mainBranchId: DEMO_MAIN_BRANCH_ID,
	parseSqlScript,
});

export default {
	async fetch(
		request: Request,
		env: PreviewWorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		ctx.passThroughOnException();
		const previewShareResponse = await handlePreviewShareRequest(request, env);
		if (previewShareResponse) {
			return withShareSecurityHeaders(previewShareResponse);
		}
		const previewHostname = new URL(request.url).hostname;
		return handleRequest(request, env, {
			executionContext: ctx,
			authenticate: (workspaceRequest) =>
				authenticatePreviewDemoBrowser(workspaceRequest, env),
			authenticateMcp: (mcpRequest) =>
				authenticatePreviewDemoMcp(mcpRequest, env),
			authorizeWorkspace: (workspaceId, auth) =>
				authorizePreviewDemoWorkspace(workspaceId, auth, env),
			workspaceFetch: (workspaceId, workspaceRequest) =>
				workspaceRuntime.fetch(
					env.PREVIEW_STATE,
					previewHostname,
					workspaceId,
					workspaceRequest,
				),
			fallback: async (fallbackRequest) =>
				withShareSecurityHeaders(await startHandler.fetch(fallbackRequest)),
		});
	},
};
