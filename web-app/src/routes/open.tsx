import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { repositoryPath } from "~/lib/repository-url";

export const Route = createFileRoute("/open")({
	component: OpenAppPage,
});

function OpenAppPage() {
	const { isLoaded: authLoaded, user } = useAuth();
	const repositoryState = useRepository();

	useEffect(() => {
		if (!authLoaded || !repositoryState.isLoaded) return;

		const activeRepository = repositoryState.activeRepository;
		const destination = activeRepository
			? repositoryPath(
					activeRepository.organization,
					activeRepository.repository,
				)
			: user
				? "/home"
				: "/sign-in?returnTo=%2Fopen";
		window.location.replace(destination);
	}, [
		authLoaded,
		user,
		repositoryState.activeRepository,
		repositoryState.isLoaded,
	]);

	return (
		<div className="min-h-screen bg-bg">
			<AppTitlebar>
				<AppTitlebarBrand />
			</AppTitlebar>
			<main className="grid min-h-[calc(100vh_-_44px)] place-items-center px-5 py-10">
				Opening LixRay...
			</main>
		</div>
	);
}
