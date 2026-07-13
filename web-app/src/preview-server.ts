import startHandler from "@tanstack/react-start/server-entry";
import { handlePreviewRequest } from "./worker/preview-handler";

export default {
	async fetch(request: Request): Promise<Response> {
		return handlePreviewRequest(request, async (fallbackRequest) =>
			startHandler.fetch(fallbackRequest),
		);
	},
};
