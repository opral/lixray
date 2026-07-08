import {
	OrganizationList,
	OrganizationProfile,
	OrganizationSwitcher,
	UserButton,
	useAuth,
} from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DatabaseZap } from "lucide-react";

export const Route = createFileRoute("/workspace")({
	component: WorkspacePage,
});

function WorkspacePage() {
	const { isLoaded, isSignedIn } = useAuth();

	if (!isLoaded) {
		return <div className="workspace-empty">Loading...</div>;
	}

	if (!isSignedIn) {
		return (
			<div className="workspace-empty">
				<div className="workspace-empty-inner">
					<p className="eyebrow">Workspace required</p>
					<h1>Sign in to manage workspaces.</h1>
					<p className="copy">
						Workspace membership is managed by Clerk Organizations.
					</p>
					<div className="toolbar">
						<Link className="button primary" to="/sign-in">
							Sign in
						</Link>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="app-shell">
			<header className="topbar">
				<Link to="/" className="brand">
					<span className="brand-mark">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</Link>
				<div className="topbar-actions">
					<OrganizationSwitcher
						hidePersonal
						afterSelectOrganizationUrl="/workspace"
						afterCreateOrganizationUrl="/workspace"
					/>
					<UserButton />
				</div>
			</header>
			<main className="page settings-grid">
				<section className="page-heading">
					<p className="eyebrow">Workspace</p>
					<h1>Members and invitations</h1>
				</section>
				<section className="panel">
					<div className="panel-header">
						<h2 className="panel-title">Select or create a workspace</h2>
					</div>
					<div className="panel-body">
						<OrganizationList
							hidePersonal
							afterSelectOrganizationUrl="/workspace"
							afterCreateOrganizationUrl="/workspace"
						/>
					</div>
				</section>
				<section className="panel">
					<div className="panel-header">
						<h2 className="panel-title">Active workspace settings</h2>
					</div>
					<div className="panel-body">
						<OrganizationProfile routing="hash" />
					</div>
				</section>
			</main>
		</div>
	);
}
