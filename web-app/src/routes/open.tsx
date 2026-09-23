import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { repositoryPath } from "~/lib/repository-url";
import { ensureInitialPersonalRepository } from "~/lib/initial-personal-repository";

export const Route = createFileRoute("/open")({
	component: OpenAppPage,
});

function OpenAppPage() {
	const { client, isLoaded: authLoaded, session, user } = useAuth();
	const repositoryState = useRepository();
	const [error, setError] = useState<string | null>(null);
	const setup = useRef<Promise<string | null> | null>(null);

	useEffect(() => {
		if (!authLoaded || !repositoryState.isLoaded) return;

		if (!user || !client || !session) {
			window.location.replace("/sign-in?returnTo=%2Fopen");
			return;
		}
		let cancelled = false;
		setup.current ??= ensureInitialPersonalRepository(
			client,
			session.access_token,
			window.location.origin,
		);
		void setup.current.then(
			(createdPath) => {
				if (cancelled) return;
				const active = repositoryState.activeRepository;
				window.location.replace(
					createdPath ??
						(active
							? repositoryPath(active.organization, active.repository)
							: "/home"),
				);
			},
			(caught: unknown) => {
				if (!cancelled) {
					setError(
						caught instanceof Error
							? caught.message
							: "Unable to open your repository.",
					);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [
		authLoaded,
		client,
		session,
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
				{error ? (
					<div className="grid gap-4 text-center">
						<p role="alert">{error}</p>
						<button type="button" onClick={() => window.location.reload()}>
							Retry opening LixRay
						</button>
					</div>
				) : (
					"Opening LixRay..."
				)}
			</main>
		</div>
	);
}
