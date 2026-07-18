import startHandler from "@tanstack/react-start/server-entry";
import { addGoogleAnalytics } from "./lib/google-analytics";
import { withShareSecurityHeaders } from "./lib/share-security";
import { handleRequest } from "./worker/handler";
import { SlateDbContainer, type Env } from "./worker/index";

export { SlateDbContainer };

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		ctx.passThroughOnException();
		return handleRequest(request, env, {
			executionContext: ctx,
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
