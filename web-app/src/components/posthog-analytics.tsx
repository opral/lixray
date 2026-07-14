import { useEffect } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { initializeTelemetry } from "~/lib/telemetry";

let identifiedUserId: string | null = null;
let groupedOrganizationId: string | null = null;
let groupedWorkspaceId: string | null = null;

export function PostHogAnalytics() {
	const { isLoaded: authLoaded, user } = useAuth();
	const { activeWorkspace, isLoaded: workspaceLoaded } = useWorkspace();

	useEffect(() => {
		void initializeTelemetry();
	}, []);

	useEffect(() => {
		if (!authLoaded) return;
		let disposed = false;
		void initializeTelemetry().then((posthog) => {
			if (!posthog || disposed) return;
			if (!user) {
				if (identifiedUserId) posthog.reset();
				identifiedUserId = null;
				groupedOrganizationId = null;
				groupedWorkspaceId = null;
				return;
			}
			if (identifiedUserId === user.id) return;
			posthog.identify(user.id);
			identifiedUserId = user.id;
			posthog.capture("user_authenticated", { source: "supabase_auth" });
		});
		return () => {
			disposed = true;
		};
	}, [authLoaded, user]);

	useEffect(() => {
		if (!authLoaded || !workspaceLoaded) return;
		let disposed = false;
		void initializeTelemetry().then((posthog) => {
			if (!posthog || disposed) return;
			if (!user || !activeWorkspace) {
				posthog.unregister("organization_id");
				posthog.unregister("workspace_id");
				groupedOrganizationId = null;
				groupedWorkspaceId = null;
				return;
			}

			const organizationId = activeWorkspace.organization.id;
			const workspaceId = activeWorkspace.workspace.id;
			if (groupedOrganizationId !== organizationId) {
				posthog.group("organization", organizationId, {
					organization_id: organizationId,
				});
				groupedOrganizationId = organizationId;
			}
			if (groupedWorkspaceId !== workspaceId) {
				posthog.group("workspace", workspaceId, {
					workspace_id: workspaceId,
				});
				groupedWorkspaceId = workspaceId;
			}
			posthog.register({
				organization_id: organizationId,
				workspace_id: workspaceId,
			});
		});
		return () => {
			disposed = true;
		};
	}, [activeWorkspace, authLoaded, user, workspaceLoaded]);

	return null;
}
