import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import type { ReactNode } from "react";
import {
	AppTitlebar,
	AppTitlebarBrand,
	AppTitlebarTitle,
} from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";

const compactSelectClass =
	"h-7 min-w-0 w-[180px] rounded-[7px] border border-border-panel bg-bg-panel py-0 pr-7 pl-2 text-[12px] text-text-primary max-[800px]:w-[132px] max-[560px]:w-[92px]";
const iconButtonClass =
	"inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-0 bg-transparent p-0 font-[680] text-text-secondary no-underline transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible disabled:cursor-not-allowed disabled:opacity-[0.55]";

export function AppShell({ children }: { children: ReactNode }) {
	const { signOut } = useAuth();
	const navigate = useNavigate();
	const {
		activeWorkspace,
		organizations,
		selectOrganization,
		selectWorkspace,
		selectedOrganization,
	} = useWorkspace();

	const openWorkspace = (workspaceId: string) => {
		const organization = organizations.find((candidate) =>
			candidate.workspaces.some((workspace) => workspace.id === workspaceId),
		);
		const workspace = organization?.workspaces.find(
			(candidate) => candidate.id === workspaceId,
		);
		if (!organization || !workspace) return;
		selectWorkspace(workspace.id);
		void navigate({
			to: "/@{$namespace}/$workspace",
			params: { namespace: organization.handle, workspace: workspace.slug },
			search: {},
		});
	};

	return (
		<div className="min-h-screen">
			<AppTitlebar className="sticky top-0 z-10 bg-bg-app/90 backdrop-blur-[16px]">
				<AppTitlebarBrand className="max-[560px]:[&_[data-app-titlebar-brand-label]]:sr-only" />
				<AppTitlebarTitle
					className={isDemoModeEnabled ? undefined : "max-[1280px]:hidden"}
				>
					SQL console
				</AppTitlebarTitle>
				<div className="ml-auto flex min-w-0 items-center gap-1.5">
					{isDemoModeEnabled ? null : (
						<>
							<label className="sr-only" htmlFor="organization-switcher">
								Organization
							</label>
							<select
								id="organization-switcher"
								className={compactSelectClass}
								value={selectedOrganization?.id ?? ""}
								onChange={(event) => {
									const organization = organizations.find(
										(candidate) => candidate.id === event.target.value,
									);
									selectOrganization(event.target.value);
									const workspace = organization?.workspaces[0];
									if (organization && workspace) {
										void navigate({
											to: "/@{$namespace}/$workspace",
											params: {
												namespace: organization.handle,
												workspace: workspace.slug,
											},
											search: {},
										});
									}
								}}
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
								className={compactSelectClass}
								value={activeWorkspace?.workspace.id ?? ""}
								onChange={(event) => openWorkspace(event.target.value)}
							>
								{selectedOrganization?.workspaces.map((workspace) => (
									<option key={workspace.id} value={workspace.id}>
										{workspace.name}
									</option>
								))}
							</select>
						</>
					)}
					{isDemoModeEnabled ? null : (
						<>
							<Link
								to="/workspace"
								className={iconButtonClass}
								aria-label="Workspace settings"
								title="Workspace settings"
							>
								<Settings size={16} aria-hidden="true" />
							</Link>
							<button
								className={iconButtonClass}
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
			</AppTitlebar>
			<main className="mx-auto w-[min(1180px,calc(100%_-_40px))] pt-6 pb-12 max-[800px]:w-[min(1180px,calc(100%_-_24px))] max-[800px]:pt-[22px]">
				{children}
			</main>
		</div>
	);
}
