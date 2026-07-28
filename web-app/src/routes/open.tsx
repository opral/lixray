import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { workspacePath } from "~/lib/workspace-url";

export const Route = createFileRoute("/open")({
	component: OpenAppPage,
});

function OpenAppPage() {
	const { isLoaded: authLoaded, user } = useAuth();
	const workspaceState = useWorkspace();

	useEffect(() => {
		if (!authLoaded || !workspaceState.isLoaded) return;

		const activeWorkspace = workspaceState.activeWorkspace;
		const destination = activeWorkspace
			? workspacePath(activeWorkspace.organization, activeWorkspace.workspace)
			: user
				? "/home"
				: "/sign-in?returnTo=%2Fopen";
		window.location.replace(destination);
	}, [
		authLoaded,
		user,
		workspaceState.activeWorkspace,
		workspaceState.isLoaded,
	]);

	return (
		<div className="min-h-screen bg-bg-app">
			<AppTitlebar>
				<AppTitlebarBrand />
			</AppTitlebar>
			<main className="grid min-h-[calc(100vh_-_44px)] place-items-center px-5 py-10">
				Opening LixRay...
			</main>
		</div>
	);
}
