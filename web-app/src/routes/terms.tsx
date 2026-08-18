import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { legalPages } from "~/lib/docs-content";

export const Route = createFileRoute("/terms")({
	head: () => ({
		meta: [{ title: `${legalPages.terms.label} — LixRay` }],
	}),
	component: TermsRoute,
});

function TermsRoute() {
	return <LegalPage slug="terms" />;
}
