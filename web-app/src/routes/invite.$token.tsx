import { createFileRoute, Navigate } from "@tanstack/react-router";

// Legacy organization-invitation URLs no longer carry an acceptance flow.
// Keep the route so old links do not become dead ends, without reading or
// handling their token.
export const Route = createFileRoute("/invite/$token")({
	component: LegacyInviteRedirect,
});

function LegacyInviteRedirect() {
	return <Navigate to="/home" replace />;
}
