/** Transport failures do not imply that publication was revoked. */
export async function publishedResponseError(
	response: Response,
): Promise<string> {
	let code: string | undefined;
	try {
		const body = (await response.clone().json()) as {
			error?: { code?: string };
		};
		code = body.error?.code;
	} catch {
		/* Non-JSON gateway errors retain their HTTP classification. */
	}
	if (response.status === 426 || code === "LIX_PROTOCOL_VERSION_MISMATCH")
		return "This public view is incompatible with the server. Please try again after the service is updated.";
	if ([401, 403, 404].includes(response.status))
		return "This file is unavailable or is no longer public.";
	if (response.status === 410)
		return "This public view expired. Reload the page to reopen it.";
	if (response.status >= 500)
		return "The server could not load this public view. Please try again shortly.";
	return `Unable to load this public view (${code ?? `HTTP ${response.status}`}).`;
}
