import type { PostHog } from "posthog-js";

export function synchronizeTelemetryIdentity(
	posthog: Pick<PostHog, "get_property" | "identify" | "reset">,
	userId: string | null,
): void {
	const persistedValue: unknown = posthog.get_property("$user_id");
	const persistedUserId =
		typeof persistedValue === "string" ? persistedValue : null;
	if (userId) {
		if (persistedUserId === userId) return;
		if (persistedUserId) posthog.reset();
		posthog.identify(userId);
	} else if (persistedUserId) {
		posthog.reset();
	}
}
