/**
 * Capability URLs are cleaned immediately. Keep this HTTP-level safeguard on
 * every browser shell so a still-loading page cannot leak a token in a
 * referrer header before client canonicalization completes.
 */
export function withShareSecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Referrer-Policy", "no-referrer");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
