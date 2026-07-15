import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LandingPage } from "~/components/landing-page";
import { WorkspaceDirectory } from "~/components/workspace-directory";

interface IndexSearch {
	app?: "1";
}

export const Route = createFileRoute("/")({
	validateSearch: (search: Record<string, unknown>): IndexSearch =>
		search.app === "1" || search.app === 1 ? { app: "1" } : {},
	component: DashboardPage,
});

function DashboardPage() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const [openedAsApp] = useState(search.app === "1");

	useEffect(() => {
		if (search.app !== "1") return;
		void navigate({ to: "/", search: {}, replace: true });
	}, [navigate, search.app]);

	return openedAsApp ? <WorkspaceDirectory /> : <LandingPage />;
}
