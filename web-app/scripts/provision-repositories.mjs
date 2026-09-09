import { pathToFileURL } from "node:url";

// Operator-only command run inside the web service, where the private service
// URL and bearer token already exist. Never expose either through a public API.
export async function provisionRepositories({
	mode,
	ids: requestedIds,
	env = process.env,
	fetchImpl = fetch,
}) {
	if (mode !== "create-new" && mode !== "adopt-existing") {
		throw new Error(
			"Choose create-new for a fresh preview or adopt-existing for existing storage.",
		);
	}
	if (!env.LIXRAY_LIX_SERVICE_URL || !env.LIXRAY_INTERNAL_TOKEN) {
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
	for (const id of ids) {
		const response = await fetchImpl(
			new URL(
				`/internal/repositories/${id}/provision`,
				env.LIXRAY_LIX_SERVICE_URL,
			),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.LIXRAY_INTERNAL_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ mode }),
				signal: AbortSignal.timeout(60_000),
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
