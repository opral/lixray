import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { legalPages } from "~/lib/docs-content";

export const Route = createFileRoute("/support")({
	head: () => ({
		meta: [{ title: `${legalPages.support.label} — LixRay` }],
	}),
	component: SupportRoute,
});

function SupportRoute() {
	return <LegalPage slug="support" />;
}
