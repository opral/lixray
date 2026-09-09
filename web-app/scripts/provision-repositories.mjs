import { pathToFileURL } from "node:url";

// Operator-only command run inside the web service, where the private service
// URL and bearer token already exist. Never expose either through a public API.
export async function provisionRepositories({
	mode,
	ids: requestedIds,
	env = process.env,
	fetchImpl = fetch,
	sleepImpl = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
	if (mode !== "create-new" && mode !== "adopt-existing") {
		throw new Error(
			"Choose create-new for a fresh preview or adopt-existing for existing storage.",
		);
	}
	const serviceUrl =
		env.LIXRAY_LIX_SERVICE_URL ??
		env.LIXRAY_REPOSITORY_SERVICE_URL ??
		env.LIXRAY_WORKSPACE_SERVICE_URL;
	if (!serviceUrl || !env.LIXRAY_INTERNAL_TOKEN) {
		throw new Error(
			"The web service's private Lix connection must be configured.",
		);
	}
	const ids = new Set(
		requestedIds ?? [
			"00000000-0000-4000-8000-000000000002",
			"00000000-0000-4000-8000-000000000005",
			...(env.LIXRAY_DEMO_LIX_IDS ?? env.LIXRAY_DEMO_REPOSITORY_IDS ?? "")
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean),
		],
	);
	for (const id of ids) {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
		) {
			throw new Error("A configured demo repository ID is invalid.");
		}
	}
	// Private traffic wakes a sleeping Railway service. Wait using a read-only
	// request so transient wake-up failures cannot repeat a provisioning write.
	for (let attempt = 0; attempt < 6; attempt++) {
		let response;
		try {
			response = await fetchImpl(new URL("/healthz", serviceUrl), {
				method: "GET",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			// Network failures during wake-up may be retried; never print credentials.
		}
		await response?.body?.cancel();
		if (response?.status === 200) break;
		const status = response ? `HTTP ${response.status}` : "network failure";
		if (
			(response && ![502, 503, 504].includes(response.status)) ||
			attempt === 5
		) {
			throw new Error(`Private Lix service did not become ready (${status}).`);
		}
		await sleepImpl(5_000);
	}
	for (const id of ids) {
		const response = await fetchImpl(
			new URL(`/internal/repositories/${id}/provision`, serviceUrl),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.LIXRAY_INTERNAL_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ mode }),
				// Adoption can include a full epoch migration. Match the bounded
				// migration window used by the production canary.
				signal: AbortSignal.timeout(
					mode === "adopt-existing" ? 9 * 60_000 : 60_000,
				),
			},
		);
		if (!response.ok) {
			throw new Error(
				`Repository ${id} provisioning failed (HTTP ${response.status}).`,
			);
		}
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await provisionRepositories({
		mode: process.argv[2],
		ids: process.argv.length > 3 ? process.argv.slice(3) : undefined,
	});
	console.log("Repositories provisioned.");
}
