import { Link, useNavigate } from "@tanstack/react-router";
import { DatabaseZap, LogOut, Settings, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { isE2eAuthEnabled } from "~/lib/e2e-client";

const brandClass =
	"inline-flex items-center gap-2.5 font-[750] tracking-normal no-underline";
const brandMarkClass =
	"grid size-7 place-items-center rounded-[7px] bg-bg-action-secondary text-text-on-action-secondary";
const compactSelectClass =
	"h-[38px] max-w-[210px] rounded-[7px] border border-border-panel bg-bg-panel py-0 pr-[30px] pl-2.5 text-text-primary max-[800px]:w-full max-[800px]:max-w-none";
const iconButtonClass =
	"inline-flex size-[38px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-border-panel bg-bg-panel p-0 font-[680] text-text-secondary no-underline disabled:cursor-not-allowed disabled:opacity-[0.55]";

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
			<header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border-panel bg-bg-panel/86 px-7 py-5 backdrop-blur-[16px] max-[800px]:flex-col max-[800px]:items-start max-[800px]:px-[18px] max-[800px]:py-4">
				<Link to="/" className={brandClass}>
					<span className={brandMarkClass}>
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</Link>
				<div className="flex items-center gap-3 max-[800px]:w-full max-[800px]:flex-wrap max-[800px]:justify-start">
					{isE2eAuthEnabled ? null : (
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
					<Link
						to="/sql"
						className={iconButtonClass}
						aria-label="SQL console"
						title="SQL console"
					>
						<SquareTerminal size={16} aria-hidden="true" />
					</Link>
					{isE2eAuthEnabled ? null : (
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
			</header>
			<main className="mx-auto w-[min(1180px,calc(100%_-_40px))] pt-6 pb-12 max-[800px]:w-[min(1180px,calc(100%_-_24px))] max-[800px]:pt-[22px]">
				{children}
			</main>
		</div>
	);
}
