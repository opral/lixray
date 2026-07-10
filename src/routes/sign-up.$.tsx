import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
	component: LegacyNestedSignUpRedirect,
});

function LegacyNestedSignUpRedirect() {
	return <Navigate to="/sign-in" replace />;
}
