import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { legalPages } from "~/lib/docs-content";

export const Route = createFileRoute("/privacy")({
	head: () => ({
		meta: [{ title: `${legalPages.privacy.label} — LixRay` }],
	}),
	component: PrivacyRoute,
});

function PrivacyRoute() {
	return <LegalPage slug="privacy" />;
}
