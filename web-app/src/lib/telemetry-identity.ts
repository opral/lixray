import type { PostHog } from "posthog-js";

export function synchronizeTelemetryIdentity(
	posthog: Pick<PostHog, "get_property" | "identify" | "reset">,
	userId: string | null,
): void {
	const persistedUserId = posthog.get_property("$user_id");
	if (userId) {
		if (persistedUserId === userId) return;
		if (persistedUserId) posthog.reset();
		posthog.identify(userId);
	} else if (persistedUserId) {
		posthog.reset();
	}
}
