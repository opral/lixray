import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import {
	AppTitlebar,
	AppTitlebarBrand,
	AppTitlebarTitle,
} from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";

const compactSelectClass =
	"h-7 min-w-0 w-[180px] rounded-[7px] border border-border-panel bg-bg-panel py-0 pr-7 pl-2 text-[12px] text-text-primary max-[800px]:w-[132px] max-[560px]:w-[92px]";
const iconButtonClass =
	"inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-0 bg-transparent p-0 font-[680] text-text-secondary no-underline transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible disabled:cursor-not-allowed disabled:opacity-[0.55]";

export function AppShell({ children }: { children: ReactNode }) {
	const { signOut } = useAuth();
	const navigate = useNavigate();
	const {
		activeRepository,
		organizations,
		selectOrganization,
		selectRepository,
		selectedOrganization,
	} = useRepository();

	const openRepository = (repositoryId: string) => {
		const organization = organizations.find((candidate) =>
			candidate.repositories.some(
				(repository) => repository.id === repositoryId,
			),
		);
		const repository = organization?.repositories.find(
			(candidate) => candidate.id === repositoryId,
		);
		if (!organization || !repository) return;
		selectRepository(repository.id);
		void navigate({
			to: "/@{$namespace}/$repository",
			params: { namespace: organization.handle, repository: repository.slug },
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
									const repository = organization?.repositories[0];
									if (organization && repository) {
										void navigate({
											to: "/@{$namespace}/$repository",
											params: {
												namespace: organization.handle,
												repository: repository.slug,
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
							<label className="sr-only" htmlFor="repository-switcher">
								Repository
							</label>
							<select
								id="repository-switcher"
								className={compactSelectClass}
								value={activeRepository?.repository.id ?? ""}
								onChange={(event) => openRepository(event.target.value)}
							>
								{selectedOrganization?.repositories.map((repository) => (
									<option key={repository.id} value={repository.id}>
										{repository.name}
									</option>
								))}
							</select>
						</>
					)}
					{isDemoModeEnabled ? null : (
						<button
							className={iconButtonClass}
							type="button"
							aria-label="Sign out"
							title="Sign out"
							onClick={() => void signOut()}
						>
							<LogOut size={16} aria-hidden="true" />
						</button>
					)}
				</div>
			</AppTitlebar>
			<main className="mx-auto w-[min(1180px,calc(100%_-_40px))] pt-6 pb-12 max-[800px]:w-[min(1180px,calc(100%_-_24px))] max-[800px]:pt-[22px]">
				{children}
			</main>
		</div>
	);
}
