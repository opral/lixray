export const PREVIEW_UNAVAILABLE_MESSAGE =
	"This frontend-only PR preview does not include LixRay backend services.";

const BACKEND_PATHS = [
	/^\/v1(?:\/|$)/,
	/^\/mcp(?:\/|$)/,
	/^\/\.well-known\/oauth-protected-resource(?:\/|$)/,
];

export function isPreviewBackendPath(pathname: string): boolean {
	return BACKEND_PATHS.some((pattern) => pattern.test(pathname));
}

export async function handlePreviewRequest(
	request: Request,
	fallback: (request: Request) => Promise<Response>,
): Promise<Response> {
	if (!isPreviewBackendPath(new URL(request.url).pathname)) {
		return fallback(request);
	}

	return Response.json(
		{
			error: {
				code: "PREVIEW_BACKEND_UNAVAILABLE",
				message: PREVIEW_UNAVAILABLE_MESSAGE,
			},
		},
		{
			status: 404,
			headers: { "Cache-Control": "no-store" },
		},
	);
}
