/** Headers for the Railway web-to-repository-service reverse proxy. */
export function lixServiceRequestHeaders(
	incoming: Headers,
	internalToken: string,
): Headers {
	const headers = new Headers(incoming);
	headers.set("authorization", `Bearer ${internalToken}`);
	// Let the public Railway edge negotiate response compression with the
	// browser. Forwarding the browser's Accept-Encoding through Node fetch can
	// leave a decoded body paired with the upstream Content-Encoding header.
	headers.set("accept-encoding", "identity");
	return headers;
}
