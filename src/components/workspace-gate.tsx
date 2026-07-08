import {
	OrganizationList,
	useAuth,
	useOrganization,
} from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { E2E_WORKSPACE_NAME } from "~/lib/e2e-auth";
import { isE2eAuthEnabled } from "~/lib/e2e-client";

export function WorkspaceGate({
	children,
}: {
	children: (organizationName: string) => ReactNode;
}) {
	if (isE2eAuthEnabled) {
		return <>{children(E2E_WORKSPACE_NAME)}</>;
	}

	return <ClerkWorkspaceGate>{children}</ClerkWorkspaceGate>;
}

function ClerkWorkspaceGate({
	children,
}: {
	children: (organizationName: string) => ReactNode;
}) {
	const { isLoaded, isSignedIn } = useAuth();
	const { organization, isLoaded: organizationLoaded } = useOrganization();

	if (!isLoaded || !organizationLoaded) {
		return <div className="workspace-empty">Loading...</div>;
	}

	if (!isSignedIn) {
		return <SignedOutHome />;
	}

	if (!organization) {
		return <WorkspaceRequired />;
	}

	return <>{children(organization.name)}</>;
}

function SignedOutHome() {
	return (
		<main className="workspace-empty">
			<div className="workspace-empty-inner">
				<p className="eyebrow">Lixray</p>
				<h1>Sign in to continue.</h1>
				<div className="toolbar">
					<Link className="button primary" to="/sign-in">
						Sign in
					</Link>
					<Link className="button" to="/sign-up">
						Create account
					</Link>
				</div>
			</div>
		</main>
	);
}

function WorkspaceRequired() {
	return (
		<main className="workspace-empty">
			<div className="workspace-empty-inner">
				<p className="eyebrow">Workspace required</p>
				<h1>Select or create a workspace.</h1>
				<div className="panel-body">
					<OrganizationList
						hidePersonal
						afterSelectOrganizationUrl="/"
						afterCreateOrganizationUrl="/"
					/>
				</div>
			</div>
		</main>
	);
}
