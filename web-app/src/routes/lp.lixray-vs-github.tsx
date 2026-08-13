import { createFileRoute } from "@tanstack/react-router";
import { VsGithubPage } from "~/components/vs-github-page";

export const Route = createFileRoute("/lp/lixray-vs-github")({
	head: () => ({
		meta: [{ title: "LixRay — The repository for the rest of your company" }],
	}),
	component: VsGithubPage,
});
