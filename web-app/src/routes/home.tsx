import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "~/components/auth-provider";
import { RepositoryDirectory } from "~/components/repository-directory";
import { prewarmLix } from "~/lib/lix-prewarm";

export const Route = createFileRoute("/home")({
	head: () => ({
		meta: [{ title: "Home · LixRay" }, { name: "robots", content: "noindex" }],
	}),
	component: HomePage,
});

function HomePage() {
	const { isLoaded, user } = useAuth();

	useEffect(() => {
		if (!isLoaded || !user) return;
		void prewarmLix().catch(() => undefined);
	}, [isLoaded, user]);

	return <RepositoryDirectory />;
}
