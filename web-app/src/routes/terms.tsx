import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DocsPage } from "~/components/docs-page";
import { docsEntryBySlug } from "~/lib/docs-content";

export const Route = createFileRoute("/terms")({
	head: () => {
		const entry = docsEntryBySlug("terms");
		return {
			meta: entry ? [{ title: `${entry.label} — LixRay` }] : [],
		};
	},
	component: TermsRoute,
});

function TermsRoute() {
	const entry = docsEntryBySlug("terms");
	if (!entry) return <Navigate to="/docs" replace />;
	return <DocsPage entry={entry} />;
}
