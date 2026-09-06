import { useEffect } from "react";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { initializeTelemetry } from "~/lib/telemetry";

let groupedOrganizationId: string | null = null;
let groupedRepositoryId: string | null = null;

export function PostHogAnalytics() {
	const { accountId, isLoaded: authLoaded, user } = useAuth();
	const { activeRepository, isLoaded: repositoryLoaded } = useRepository();

	useEffect(() => {
		void initializeTelemetry();
	}, []);

	useEffect(() => {
		if (!authLoaded || !user || !accountId) return;
		let disposed = false;
		void initializeTelemetry().then((posthog) => {
			if (!posthog || disposed) return;
			posthog.identify(accountId, {
				email: user.email,
				name:
					typeof user.user_metadata.full_name === "string"
						? user.user_metadata.full_name
						: undefined,
			});
		});
		return () => {
			disposed = true;
		};
	}, [accountId, authLoaded, user]);

	useEffect(() => {
		if (!authLoaded || !repositoryLoaded) return;
		let disposed = false;
		void initializeTelemetry().then((posthog) => {
			if (!posthog || disposed) return;
			if (!user || !activeRepository) {
				posthog.unregister("namespace_id");
				posthog.unregister("lix_id");
				groupedOrganizationId = null;
				groupedRepositoryId = null;
				return;
			}

			const organizationId = activeRepository.organization.id;
			const repositoryId = activeRepository.repository.id;
			if (groupedOrganizationId !== organizationId) {
				posthog.group("organization", organizationId, {
					namespace_id: organizationId,
				});
				groupedOrganizationId = organizationId;
			}
			if (groupedRepositoryId !== repositoryId) {
				posthog.group("repository", repositoryId, {
					lix_id: repositoryId,
				});
				groupedRepositoryId = repositoryId;
			}
			posthog.register({
				namespace_id: organizationId,
				lix_id: repositoryId,
			});
		});
		return () => {
			disposed = true;
		};
	}, [activeRepository, authLoaded, user, repositoryLoaded]);

	return null;
}
