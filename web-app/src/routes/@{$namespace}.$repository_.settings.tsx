import { createFileRoute } from "@tanstack/react-router";
import { RepositorySettings } from "~/components/repository-settings";

export const Route = createFileRoute("/@{$namespace}/$repository_/settings")({
	head: () => ({
		meta: [
			{ title: "Repository settings · LixRay" },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: RepositorySettingsPage,
});

function RepositorySettingsPage() {
	const { namespace, repository } = Route.useParams();
	return (
		<RepositorySettings namespace={namespace} repositorySlug={repository} />
	);
}
