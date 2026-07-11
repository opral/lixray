import { Link } from "@tanstack/react-router";
import { DatabaseZap, LogOut, Settings, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { isE2eAuthEnabled } from "~/lib/e2e-client";

export function AppShell({ children }: { children: ReactNode }) {
	const { signOut } = useAuth();
	const {
		activeWorkspace,
		organizations,
		selectOrganization,
		selectWorkspace,
		selectedOrganization,
	} = useWorkspace();

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
					{isE2eAuthEnabled ? null : (
						<>
							<label className="sr-only" htmlFor="organization-switcher">
								Organization
							</label>
							<select
								id="organization-switcher"
								className="compact-select"
								value={selectedOrganization?.id ?? ""}
								onChange={(event) => selectOrganization(event.target.value)}
							>
								{organizations.map((organization) => (
									<option key={organization.id} value={organization.id}>
										{organization.name}
									</option>
								))}
							</select>
							<label className="sr-only" htmlFor="workspace-switcher">
								Workspace
							</label>
							<select
								id="workspace-switcher"
								className="compact-select"
								value={activeWorkspace?.workspace.id ?? ""}
								onChange={(event) => selectWorkspace(event.target.value)}
							>
								{selectedOrganization?.workspaces.map((workspace) => (
									<option key={workspace.id} value={workspace.id}>
										{workspace.name}
									</option>
								))}
							</select>
						</>
					)}
					<Link
						to="/sql"
						className="button icon-button"
						aria-label="SQL console"
						title="SQL console"
					>
						<SquareTerminal size={16} aria-hidden="true" />
					</Link>
					{isE2eAuthEnabled ? null : (
						<>
							<Link
								to="/workspace"
								className="button icon-button"
								aria-label="Workspace settings"
								title="Workspace settings"
							>
								<Settings size={16} aria-hidden="true" />
							</Link>
							<button
								className="button icon-button"
								type="button"
								aria-label="Sign out"
								title="Sign out"
								onClick={() => void signOut()}
							>
								<LogOut size={16} aria-hidden="true" />
							</button>
						</>
					)}
				</div>
			</header>
			<main className="page">{children}</main>
		</div>
	);
}
