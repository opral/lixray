const LIXRAY_TRUSTED_PRINCIPAL_HEADER = "x-lixray-idempotency-principal";
const LIX_ACCOUNT_ID_HEADER = "x-lix-account-id";
const LIX_IDEMPOTENCY_SCOPE_HEADER = "x-lix-idempotency-scope";
const LIX_ANONYMOUS_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";

/** Headers for the trusted Railway web-to-Lix-server reverse proxy. */
export function lixServiceRequestHeaders(
	incoming: Headers,
	internalToken: string,
): Headers {
	const headers = new Headers(incoming);
	const trustedPrincipal = headers.get(LIXRAY_TRUSTED_PRINCIPAL_HEADER);
	// Product clients must not be able to select a protocol account. Only the
	// authenticated LixRay gateway translates its private principal marker into
	// the generic reference server's trusted identity headers.
	headers.delete(LIXRAY_TRUSTED_PRINCIPAL_HEADER);
	headers.delete(LIX_ACCOUNT_ID_HEADER);
	headers.delete(LIX_IDEMPOTENCY_SCOPE_HEADER);
	if (trustedPrincipal) {
		headers.set(
			LIX_ACCOUNT_ID_HEADER,
			trustedPrincipal === "lixray-demo"
				? LIX_ANONYMOUS_ACCOUNT_ID
				: trustedPrincipal,
		);
		headers.set(LIX_IDEMPOTENCY_SCOPE_HEADER, trustedPrincipal);
	}
	headers.set("authorization", `Bearer ${internalToken}`);
	// Let the public Railway edge negotiate response compression with the
	// browser. Forwarding the browser's Accept-Encoding through Node fetch can
	// leave a decoded body paired with the upstream Content-Encoding header.
	headers.set("accept-encoding", "identity");
	return headers;
}
