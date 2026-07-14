import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
import { WorkspaceAtelier } from "~/components/workspace-atelier";
import { useWorkspace } from "~/components/workspace-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { normalizeDirPath } from "~/lib/file-explorer-api";
import { findWorkspaceByRoute } from "~/lib/workspace-url";

export const Route = createFileRoute("/@{$namespace}/$workspace")({
	ssr: false,
	validateSearch: (
		search: Record<string, unknown>,
	): { dir?: string; branch?: string } => {
		const dir = normalizeDirPath(search.dir);
		const branch =
			typeof search.branch === "string" && search.branch.trim().length > 0
				? search.branch.trim()
				: undefined;
		return {
			...(dir === "/" ? {} : { dir }),
			...(branch ? { branch } : {}),
		};
	},
	component: WorkspaceRoutePage,
});

function WorkspaceRoutePage() {
	const { namespace, workspace: workspaceSlug } = Route.useParams();
	const { branch } = Route.useSearch();
	const auth = useAuth();
	const workspaceState = useWorkspace();
	const resolved = findWorkspaceByRoute(
		workspaceState.organizations,
		namespace,
		workspaceSlug,
	);

	useEffect(() => {
		if (
			resolved &&
			workspaceState.activeWorkspace?.workspace.id !== resolved.workspace.id
		) {
			workspaceState.selectWorkspace(resolved.workspace.id);
		}
	}, [resolved, workspaceState]);

	if (
		(!isDemoModeEnabled && !auth.isLoaded) ||
		!workspaceState.isLoaded ||
		(resolved &&
			workspaceState.activeWorkspace?.workspace.id !== resolved.workspace.id)
	) {
		return <WorkspaceRouteStatus>Opening workspace…</WorkspaceRouteStatus>;
	}
	if (!isDemoModeEnabled && !auth.user) {
		return (
			<WorkspaceRouteStatus>
				<span>Sign in to open this workspace.</span>
				<Button asChild>
					<Link to="/sign-in">Sign in</Link>
				</Button>
			</WorkspaceRouteStatus>
		);
	}
	if (workspaceState.error) {
		return <WorkspaceRouteStatus>{workspaceState.error}</WorkspaceRouteStatus>;
	}
	if (!resolved) {
		return (
			<WorkspaceRouteStatus>
				<strong>Workspace not found</strong>
				<Button asChild variant="outline">
					<Link to="/">Back to workspaces</Link>
				</Button>
			</WorkspaceRouteStatus>
		);
	}

	return (
		<WorkspaceAtelier
			key={resolved.workspace.id}
			workspaceId={resolved.workspace.id}
			namespace={namespace}
			workspaceSlug={workspaceSlug}
			branchId={branch}
		/>
	);
}

function WorkspaceRouteStatus({ children }: { children: ReactNode }) {
	return (
		<main className="grid min-h-[70vh] place-content-center justify-items-center gap-3.5 p-8 text-center text-text-secondary">
			{children}
		</main>
	);
}
