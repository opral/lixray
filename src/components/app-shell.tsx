import { OrganizationSwitcher, UserButton } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { DatabaseZap, Settings, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { isE2eAuthEnabled } from "~/lib/e2e-client";

export function AppShell({ children }: { children: ReactNode }) {
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
						<OrganizationSwitcher
							hidePersonal
							afterSelectOrganizationUrl="/"
							afterCreateOrganizationUrl="/"
						/>
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
							<UserButton />
						</>
					)}
				</div>
			</header>
			<main className="page">{children}</main>
		</div>
	);
}
