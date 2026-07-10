import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up")({
	component: LegacySignUpRedirect,
});

function LegacySignUpRedirect() {
	return <Navigate to="/sign-in" replace />;
}
