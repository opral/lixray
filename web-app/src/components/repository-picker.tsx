import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, LayoutGrid, Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { CreateRepositoryDialog } from "~/components/repository-directory";
import {
	repositoryInitials,
	repositoryPalette,
	type RepositoryPalette,
} from "~/components/repository-identity";
import {
	type Organization,
	type Repository,
	useRepository,
} from "~/components/repository-provider";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/**
 * Repository switcher shown in the workspace top bar, beside the logo.
 * Lists the current namespace's repositories; visitors without membership
 * (public readers) get a plain, non-interactive repository label instead.
 */
export function RepositoryPicker({
	namespaceId,
	namespaceHandle,
	repositoryName,
	repositorySlug,
}: {
	namespaceId: string;
	namespaceHandle: string;
	repositoryName: string;
	repositorySlug: string;
}) {
	const repositoryState = useRepository();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);

	const organizations = repositoryState.organizations;
	const organization = organizations.find(
		(candidate) => candidate.id === namespaceId,
	);
	// Same flattened ordering as the directory tiles so a repository keeps
	// its chip color across views.
	const paletteOrder = useMemo(
		() =>
			new Map(
				organizations
					.flatMap((candidate) => candidate.repositories)
					.map((repository, index) => [repository.id, index] as const),
			),
		[organizations],
	);

	const activeRepository = organization?.repositories.find(
		(candidate) => candidate.slug === repositorySlug,
	);

	if (!organization || !activeRepository) {
		return (
			<span className="-ml-[3px] flex h-7 min-w-0 items-center gap-1 rounded-[7px] py-0 pr-1 pl-[5px] text-[13px] font-semibold text-text-primary">
				<RepositoryChip
					initials={repositoryInitials(repositoryName)}
					palette={repositoryPalette(0)}
				/>
				<span className="max-w-[120px] truncate text-text-secondary">
					{namespaceHandle}
				</span>
				<span className="shrink-0 text-text-tertiary">/</span>
				<span className="max-w-[180px] truncate">{repositoryName}</span>
			</span>
		);
	}

	const canCreate = organizations.some((candidate) => candidate.role !== null);
	const writableOrganizations = [
		...(organization.role !== null ? [organization] : []),
		...organizations.filter(
			(candidate) =>
				candidate.role !== null && candidate.id !== organization.id,
		),
	];

	const openRepository = (owner: Organization, repository: Repository) => {
		if (repository.id === activeRepository.id) return;
		repositoryState.selectRepository(repository.id);
		void navigate({
			to: "/@{$namespace}/$repository",
			params: {
				namespace: owner.handle,
				repository: repository.slug,
			},
			search: {},
		});
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						data-testid="repository-picker"
						aria-label={`Switch repository — current: ${organization.handle} / ${activeRepository.name}`}
						className="-ml-[3px] flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-[7px] border-0 bg-transparent py-0 pr-1 pl-[5px] text-[13px] font-semibold text-text-primary transition-colors hover:bg-bg-hover-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible data-[state=open]:bg-bg-active"
					>
						<RepositoryChip
							initials={repositoryInitials(activeRepository.name)}
							palette={repositoryPalette(
								paletteOrder.get(activeRepository.id) ?? 0,
							)}
						/>
						<span className="max-w-[120px] truncate text-text-secondary">
							{organization.handle}
						</span>
						<span className="shrink-0 text-text-tertiary">/</span>
						<span className="max-w-[180px] truncate">
							{activeRepository.name}
						</span>
						<ChevronDown
							className="size-3.5 shrink-0 text-icon-tertiary"
							aria-hidden="true"
						/>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					sideOffset={6}
					className="w-[248px] min-w-[248px] rounded-[10px] border-border-panel bg-bg-panel p-[5px] shadow-lg [&_[data-slot=dropdown-menu-item]]:gap-[9px] [&_[data-slot=dropdown-menu-item]]:rounded-[7px] [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-[7px] [&_[data-slot=dropdown-menu-item]]:text-[13px] [&_[data-slot=dropdown-menu-item]]:leading-tight [&_[data-slot=dropdown-menu-item]]:text-text-secondary [&_[data-slot=dropdown-menu-item]:focus]:bg-bg-hover [&_[data-slot=dropdown-menu-separator]]:mx-2 [&_[data-slot=dropdown-menu-separator]]:my-[5px] [&_[data-slot=dropdown-menu-separator]]:bg-border-subtle"
				>
					{organizations.map((owner) => (
						<div key={owner.id}>
							<div className="flex items-baseline gap-1.5 px-2 pt-[7px] pb-1 text-[11.5px]">
								<span className="min-w-0 truncate font-semibold text-text-secondary">
									@{owner.handle}
								</span>
								<span className="shrink-0 text-text-tertiary">
									· {owner.repositories.length}{" "}
									{owner.repositories.length === 1 ? "repo" : "repos"}
								</span>
							</div>
							{owner.repositories.map((repository) => {
								const isActive = repository.id === activeRepository.id;
								return (
									<DropdownMenuItem
										key={repository.id}
										data-active={isActive || undefined}
										className="data-[active]:bg-bg-selection-current data-[active]:text-text-primary data-[active]:focus:bg-bg-selection-current"
										onSelect={() => openRepository(owner, repository)}
									>
										<RepositoryChip
											initials={repositoryInitials(repository.name)}
											palette={repositoryPalette(
												paletteOrder.get(repository.id) ?? 0,
											)}
										/>
										<span className="min-w-0 truncate">{repository.name}</span>
										{isActive ? (
											<Check
												className="ml-auto size-3.5 shrink-0 stroke-[2.5] text-icon-selection-current"
												aria-hidden="true"
											/>
										) : null}
									</DropdownMenuItem>
								);
							})}
						</div>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() =>
							void navigate({
								to: "/@{$namespace}/$repository/settings",
								params: {
									namespace: organization.handle,
									repository: activeRepository.slug,
								},
							})
						}
					>
						<Settings
							className="size-3.5 text-icon-tertiary"
							aria-hidden="true"
						/>
						Repository settings
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => void navigate({ to: "/home" })}>
						<LayoutGrid
							className="size-3.5 text-icon-tertiary"
							aria-hidden="true"
						/>
						All repositories
					</DropdownMenuItem>
					{canCreate ? (
						<DropdownMenuItem onSelect={() => setCreating(true)}>
							<Plus
								className="size-3.5 text-icon-tertiary"
								aria-hidden="true"
							/>
							New repository
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{canCreate ? (
				<CreateRepositoryDialog
					open={creating}
					organizations={writableOrganizations}
					onClose={() => setCreating(false)}
				/>
			) : null}
		</>
	);
}

function RepositoryChip({
	initials,
	palette,
}: {
	initials: string;
	palette: RepositoryPalette;
}) {
	return (
		<span
			className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[9px] font-bold tracking-[-0.01em]"
			style={{
				background: palette.background,
				boxShadow: `inset 0 0 0 1px ${palette.border}`,
				color: palette.color,
			}}
			aria-hidden="true"
		>
			{initials}
		</span>
	);
}
