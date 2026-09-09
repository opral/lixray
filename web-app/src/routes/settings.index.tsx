import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useRepository } from "~/components/repository-provider";
import { useAuth } from "~/components/auth-provider";
export const Route = createFileRoute("/settings/")({
	component: AccountSettings,
});
function AccountSettings() {
	const { user, isLoaded: authLoaded } = useAuth();
	const { organizations, isLoaded } = useRepository();
	if (!authLoaded || !isLoaded) return <p>Loading settings…</p>;
	if (!user)
		return <Navigate to="/sign-in" search={{ returnTo: "/settings" }} />;
	const personal = organizations.find(
		(organization) => organization.isPersonal && organization.role === "owner",
	);
	return personal ? (
		<Navigate
			to="/settings/@{$namespace}"
			params={{ namespace: personal.handle }}
		/>
	) : (
		<Navigate to="/home" />
	);
}
