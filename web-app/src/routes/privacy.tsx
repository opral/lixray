import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DocsPage } from "~/components/docs-page";
import { docsEntryBySlug } from "~/lib/docs-content";

export const Route = createFileRoute("/privacy")({
	head: () => {
		const entry = docsEntryBySlug("privacy");
		return {
			meta: entry ? [{ title: `${entry.label} — LixRay` }] : [],
		};
	},
	component: PrivacyRoute,
});

function PrivacyRoute() {
	const entry = docsEntryBySlug("privacy");
	if (!entry) return <Navigate to="/docs" replace />;
	return <DocsPage entry={entry} />;
}
