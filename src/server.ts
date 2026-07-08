import startHandler from "@tanstack/react-start/server-entry";
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
			fallback: async (fallbackRequest) =>
				await startHandler.fetch(fallbackRequest),
		});
	},
};
