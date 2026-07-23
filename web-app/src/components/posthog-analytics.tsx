import { useEffect } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { initializeTelemetry } from "~/lib/telemetry";

let groupedOrganizationId: string | null = null;
let groupedWorkspaceId: string | null = null;

export function PostHogAnalytics() {
	const { isLoaded: authLoaded, user } = useAuth();
	const { activeWorkspace, isLoaded: workspaceLoaded } = useWorkspace();
	const userId = user?.id;

	useEffect(() => {
		void initializeTelemetry();
	}, []);

	useEffect(() => {
		if (!authLoaded || !userId) return;
		let disposed = false;
		void initializeTelemetry().then((posthog) => {
			if (!posthog || disposed) return;
			posthog.identify(userId);
		});
		return () => {
			disposed = true;
		};
	}, [authLoaded, userId]);

	useEffect(() => {
		if (!authLoaded || !workspaceLoaded) return;
		let disposed = false;
		void initializeTelemetry().then((posthog) => {
			if (!posthog || disposed) return;
			if (!user || !activeWorkspace) {
				posthog.unregister("namespace_id");
				posthog.unregister("lix_id");
				groupedOrganizationId = null;
				groupedWorkspaceId = null;
				return;
			}

			const organizationId = activeWorkspace.organization.id;
			const workspaceId = activeWorkspace.workspace.id;
			if (groupedOrganizationId !== organizationId) {
				posthog.group("organization", organizationId, {
					namespace_id: organizationId,
				});
				groupedOrganizationId = organizationId;
			}
			if (groupedWorkspaceId !== workspaceId) {
				posthog.group("workspace", workspaceId, {
					lix_id: workspaceId,
				});
				groupedWorkspaceId = workspaceId;
			}
			posthog.register({
				namespace_id: organizationId,
				lix_id: workspaceId,
			});
		});
		return () => {
			disposed = true;
		};
	}, [activeWorkspace, authLoaded, user, workspaceLoaded]);

	return null;
}
