import { createFileRoute, Navigate } from "@tanstack/react-router";
import { docsEntries } from "~/lib/docs-content";

export const Route = createFileRoute("/docs/")({
	component: DocsIndexRedirect,
});

function DocsIndexRedirect() {
	return (
		<Navigate to="/docs/$slug" params={{ slug: docsEntries[0].slug }} replace />
	);
}
