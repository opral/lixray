import { createFileRoute } from "@tanstack/react-router";
import { NamespaceSettings } from "~/components/namespace-settings";

export const Route = createFileRoute("/settings/@{$namespace}")({
	head: () => ({
		meta: [
			{ title: "Settings · LixRay" },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: SettingsPage,
});

function SettingsPage() {
	const { namespace } = Route.useParams();
	return <NamespaceSettings handle={namespace} />;
}
