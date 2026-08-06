const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export async function waitForSupabaseAuthDatabase({
	supabaseUrl,
	secretKey,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	fetchImpl = fetch,
	sleep = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
	const usersUrl = new URL(
		"/auth/v1/admin/users?page=1&per_page=1",
		supabaseUrl,
	);
	const deadline = Date.now() + timeoutMs;
	let lastFailure = "no response";

	console.log(
		`Waiting for local Supabase auth database at ${usersUrl.origin}...`,
	);
	while (Date.now() < deadline) {
		try {
			const response = await fetchImpl(usersUrl, {
				headers: {
					apikey: secretKey,
					Authorization: `Bearer ${secretKey}`,
				},
				signal: AbortSignal.timeout(requestTimeoutMs),
			});
			if (response.ok) return;
			lastFailure = `HTTP ${response.status}: ${(await response.text()).trim()}`;
		} catch (caught) {
			lastFailure = caught instanceof Error ? caught.message : String(caught);
		}
		await sleep(pollIntervalMs);
	}

	throw new Error(
		`Local Supabase auth could not reach its database within ${timeoutMs / 1_000} seconds. Last failure: ${lastFailure}`,
	);
}
