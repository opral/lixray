import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DocsPage } from "~/components/docs-page";
import { docsEntryBySlug } from "~/lib/docs-content";

export const Route = createFileRoute("/docs/$slug")({
	head: ({ params }) => {
		const entry = docsEntryBySlug(params.slug);
		return {
			meta: entry ? [{ title: `${entry.label} — LixRay Docs` }] : [],
		};
	},
	component: DocsRoute,
});

function DocsRoute() {
	const { slug } = Route.useParams();
	const entry = docsEntryBySlug(slug);
	if (!entry) return <Navigate to="/docs" replace />;
	return <DocsPage entry={entry} />;
}
