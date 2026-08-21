import type { PublicProfileActivity } from "~/lib/profile-activity-aggregate";

export async function resolvePublicProfileActivity(input: {
	namespaceId: string;
}): Promise<PublicProfileActivity> {
	const response = await fetch(
		`/profile/${encodeURIComponent(input.namespaceId)}/activity`,
		{ headers: { Accept: "application/json" } },
	);
	if (!response.ok) {
		throw new Error("Unable to load public repositories.");
	}
	return (await response.json()) as PublicProfileActivity;
}
