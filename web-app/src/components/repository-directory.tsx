import { Link } from "@tanstack/react-router";
import {
	ChevronDown,
	Download,
	Ellipsis,
	Link2,
	Plus,
	Settings,
} from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { AccountMenu } from "~/components/account-menu";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import {
	type Organization,
	type Repository,
	useRepository,
} from "~/components/repository-provider";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { triggerBrowserDownload } from "~/lib/download";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { formatCaughtError, formatRelativeTime } from "~/lib/format";
import {
	buildRepositoryArchive,
	fetchRepositoryFileCount,
} from "~/lib/repository-archive";
import { repositoryPath } from "~/lib/repository-url";
import {
	repositoryInitials,
	TILE_PALETTES,
} from "~/components/repository-identity";
import { CreateOrganizationDialog } from "~/components/create-organization-dialog";

type DialogState =
	| { type: "create"; organizationId?: string }
	| { type: "rename"; organization: Organization; repository: Repository }
	| { type: "delete"; organization: Organization; repository: Repository }
	| null;

export function RepositoryDirectory() {
	const auth = useAuth();
	const repositoryState = useRepository();
	const [dialog, setDialog] = useState<DialogState>(null);
	const [creatingOrganization, setCreatingOrganization] = useState(false);
	const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
	const signedIn = isDemoModeEnabled || Boolean(auth.user);
	const organizations = repositoryState.organizations;
	const writableOrganizations = organizations.filter(
		(organization) => organization.role !== null,
	);

	useEffect(() => {
		let cancelled = false;
		setFileCounts({});
		for (const organization of organizations) {
			for (const repository of organization.repositories) {
				void fetchRepositoryFileCount({
					namespace: organization.handle,
					repositorySlug: repository.slug,
					getAccessToken: auth.getAccessToken,
				})
					.then((count) => {
						if (!cancelled) {
							setFileCounts((current) => ({
								...current,
								[repository.id]: count,
							}));
						}
					})
					.catch(() => undefined);
			}
		}
		return () => {
			cancelled = true;
		};
	}, [auth.getAccessToken, organizations]);

	if ((!isDemoModeEnabled && !auth.isLoaded) || !repositoryState.isLoaded) {
		return <DirectoryStatus>Loading repositories…</DirectoryStatus>;
	}
	if (!signedIn) return <SignedOutDirectory />;
	if (repositoryState.error) {
		return (
			<DirectoryStatus>
				<span>{repositoryState.error}</span>
				<Button
					variant="featured"
					className="font-bold"
					onClick={() => void repositoryState.refresh()}
				>
					Try again
				</Button>
			</DirectoryStatus>
		);
	}

	const repositoryCount = organizations.reduce(
		(total, organization) => total + organization.repositories.length,
		0,
	);
	const namespaceCount = organizations.filter(
		(organization) => organization.repositories.length > 0,
	).length;
	const hasEmptyOrganizations = organizations.some(
		(organization) =>
			!organization.isPersonal && organization.repositories.length === 0,
	);
	const paletteOrder = new Map(
		organizations
			.flatMap((organization) => organization.repositories)
			.map((repository, index) => [repository.id, index] as const),
	);
	return (
		<div
			className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary"
			data-testid="repository-directory"
		>
			<DirectoryHeader />
			<main className="flex min-h-0 flex-1 justify-center overflow-auto">
				<section
					className="w-[min(920px,calc(100%-32px))] pt-14 pb-[60px] max-[560px]:w-[min(100%-20px,920px)] max-[560px]:pt-[34px]"
					aria-labelledby="repositories-title"
				>
					<div className="flex items-center gap-4 px-3.5 pb-1.5 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:px-2">
						<h1
							className="m-0 text-[27px] leading-[1.2] font-bold tracking-[-0.02em]"
							id="repositories-title"
						>
							Repositories
						</h1>
						<Button
							variant="featured"
							className="ml-auto h-9 gap-1.5 px-3.5 text-[13.5px] font-bold max-[560px]:ml-0 max-[560px]:self-start"
							data-testid="new-repository-button"
							type="button"
							disabled={writableOrganizations.length === 0}
							onClick={() => setDialog({ type: "create" })}
						>
							<Plus className="size-3.5" aria-hidden="true" />
							New repository
						</Button>
					</div>
					{repositoryCount > 0 ? (
						<p className="m-0 px-3.5 pb-[30px] text-[13.5px] leading-normal text-text-tertiary max-[560px]:px-2 max-[560px]:pt-1 max-[560px]:pb-6">
							{repositoryCount}{" "}
							{pluralize(repositoryCount, "repository", "repositories")} across{" "}
							{namespaceCount} {pluralize(namespaceCount, "namespace")}
						</p>
					) : null}

					{repositoryCount === 0 && !hasEmptyOrganizations ? (
						<RepositoryEmptyState />
					) : (
						organizations.map((organization, groupIndex) =>
							organization.repositories.length > 0 ||
							!organization.isPersonal ? (
								<section
									className="pt-[26px] data-[first=true]:pt-0"
									data-first={groupIndex === 0 || undefined}
									key={organization.id}
									aria-labelledby={`namespace-${organization.id}`}
								>
									<div className="flex items-baseline gap-2 px-3.5 pb-1.5 max-[560px]:px-2">
										<h2
											className="m-0 text-[14px] leading-[1.35] font-bold tracking-[-0.01em]"
											id={`namespace-${organization.id}`}
										>
											<Link
												to="/@{$namespace}"
												params={{ namespace: organization.handle }}
												aria-label={`View the @${organization.handle} profile`}
												className="rounded-[5px] text-inherit no-underline transition-colors hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible"
											>
												@{organization.handle}
											</Link>
										</h2>
										<span className="text-[12px] text-text-tertiary">
											{organization.repositories.length}{" "}
											{pluralize(
												organization.repositories.length,
												"repository",
												"repositories",
											)}
										</span>
										<span className="flex-1" />
										{organization.role !== null ? (
											<Link
												to="/settings/@{$namespace}"
												params={{ namespace: organization.handle }}
												aria-label={`Settings for @${organization.handle}`}
												className="inline-flex size-6 shrink-0 items-center justify-center self-center rounded-[7px] text-icon-quaternary transition-colors hover:bg-bg-hover-canvas hover:text-icon-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible"
											>
												<Settings className="size-[14px]" aria-hidden="true" />
											</Link>
										) : null}
									</div>
									{organization.repositories.length === 0 ? (
										<EmptyOrganizationSection
											organization={organization}
											onNewRepository={() =>
												setDialog({
													type: "create",
													organizationId: organization.id,
												})
											}
										/>
									) : (
										<div className="flex flex-col">
											{organization.repositories.map((repository) => (
												<RepositoryRow
													key={repository.id}
													organization={organization}
													repository={repository}
													fileCount={fileCounts[repository.id]}
													paletteIndex={paletteOrder.get(repository.id) ?? 0}
												/>
											))}
										</div>
									)}
								</section>
							) : null,
						)
					)}

					{!isDemoModeEnabled &&
					!organizations.some((organization) => !organization.isPersonal) ? (
						<button
							className="mx-3.5 mt-[26px] flex w-[calc(100%-28px)] cursor-pointer items-center gap-3.5 rounded-[10px] border-[1.5px] border-dashed border-border-action-secondary bg-transparent px-4 py-[13px] text-left transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible max-[560px]:mx-2 max-[560px]:w-[calc(100%-16px)]"
							type="button"
							data-testid="create-organization-row"
							onClick={() => setCreatingOrganization(true)}
						>
							<span
								className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-bg-hover-canvas text-[15px] text-text-secondary"
								aria-hidden="true"
							>
								<Plus className="size-4" />
							</span>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-[13.5px] leading-tight font-semibold text-text-secondary">
									Create an organization
								</span>
								<span className="text-[12.5px] leading-tight text-text-tertiary">
									Shared repositories for your company — teammates and agents
									work in one place.
								</span>
							</span>
						</button>
					) : null}
				</section>
			</main>

			<RepositoryDialog
				dialog={dialog}
				organizations={writableOrganizations}
				onClose={() => setDialog(null)}
			/>
			<CreateOrganizationDialog
				open={creatingOrganization}
				onClose={() => setCreatingOrganization(false)}
			/>
		</div>
	);
}

/**
 * A freshly created organization has no repositories; this section makes the
 * next two moves obvious. Invites currently travel on repository links, so
 * the invite affordance points people at creating the first repository.
 */
function EmptyOrganizationSection({
	organization,
	onNewRepository,
}: {
	organization: Organization;
	onNewRepository: () => void;
}) {
	return (
		<div
			className="mx-3.5 rounded-xl border border-border-panel bg-bg-panel px-6 py-[22px] text-center max-[560px]:mx-2"
			data-testid="empty-organization-section"
		>
			<p className="m-0 text-[14px] font-bold">
				@{organization.handle} is ready
			</p>
			<p className="mx-auto mt-1.5 mb-3.5 max-w-[440px] text-[12.5px] leading-normal text-text-tertiary">
				No repositories yet. Create the first one, or bring your team in —
				everyone you invite sees every repository in this organization.
			</p>
			<div className="flex justify-center gap-2">
				<Button
					variant="featured"
					className="gap-1.5 font-bold"
					type="button"
					onClick={onNewRepository}
				>
					<Plus className="size-3.5" aria-hidden="true" />
					New repository
				</Button>
				<Button
					variant="outline"
					type="button"
					onClick={() =>
						toast(
							"Invites travel on repository links — create the first repository, then invite your team from its Share menu.",
						)
					}
				>
					Invite teammates
				</Button>
			</div>
		</div>
	);
}

export function DirectoryHeader() {
	return (
		<AppTitlebar>
			<AppTitlebarBrand href="/" />
			<AccountMenu className="ml-auto size-[26px] border-0" />
		</AppTitlebar>
	);
}

function RepositoryEmptyState() {
	return (
		<div
			className="grid min-h-[480px] place-content-center justify-items-center px-4 pb-16 text-center max-[560px]:min-h-[400px] max-[560px]:pb-8"
			data-testid="repository-empty-state"
		>
			<div
				className="relative mb-8 h-[176px] w-[360px] max-w-full"
				aria-hidden="true"
			>
				<div className="absolute top-[86px] left-[28px] h-px w-[95px] -rotate-[28deg] border-t-2 border-dashed border-border-panel" />
				<div className="absolute top-[64px] right-[32px] h-px w-[92px] rotate-[24deg] border-t-2 border-dashed border-border-panel" />
				<div className="absolute top-[28px] right-[58px] h-px w-[74px] -rotate-[20deg] border-t-2 border-dashed border-border-panel" />

				<div className="absolute top-8 left-1/2 w-[230px] -translate-x-1/2 overflow-hidden rounded-xl border border-border-panel bg-bg-panel shadow-[0_18px_40px_rgba(28,25,23,0.08)]">
					<div className="flex h-10 items-center gap-2 border-b border-border-subtle px-3">
						<img className="size-4" src="/landing/icon-folder.svg" alt="" />
						<span className="h-2 w-20 rounded-full bg-bg-action-secondary/20" />
					</div>
					<div className="grid gap-3 p-3">
						<div className="flex items-center gap-2">
							<span className="size-3 rounded-[3px] bg-[#25211f]" />
							<span className="h-2 w-24 rounded-full bg-bg-action-secondary/20" />
							<img
								className="ml-auto size-4"
								src="/landing/brand-openai.svg"
								alt=""
							/>
						</div>
						<div className="flex items-center gap-2">
							<span className="size-3 rounded-[3px] bg-[#3b82f6]" />
							<span className="h-2 w-16 rounded-full bg-bg-action-secondary/20" />
							<img
								className="ml-auto size-4"
								src="/landing/claude-spark.svg"
								alt=""
							/>
						</div>
						<div className="flex items-center gap-2">
							<span className="size-3 rounded-[3px] bg-[#8b5cf6]" />
							<span className="h-2 w-28 rounded-full bg-bg-action-secondary/20" />
						</div>
					</div>
				</div>

				<div className="absolute bottom-0 left-4 grid size-11 place-items-center rounded-xl border border-[#eadfce] bg-[#fff9ef] shadow-sm">
					<img className="size-6" src="/landing/claude-spark.svg" alt="" />
				</div>
				<div className="absolute top-2 right-5 grid size-11 place-items-center rounded-xl border border-border-panel bg-bg-panel shadow-sm">
					<img className="size-5" src="/landing/brand-openai.svg" alt="" />
				</div>
				<div className="absolute right-1 bottom-1 grid size-11 place-items-center rounded-xl border border-border-panel bg-bg-panel shadow-sm">
					<img className="size-5" src="/landing/brand-gemini.svg" alt="" />
				</div>
			</div>
			<h2 className="m-0 text-[20px] leading-tight font-bold tracking-[-0.015em]">
				No repositories yet
			</h2>
			<p className="mt-2 mb-0 max-w-[480px] text-[14px] leading-[1.5] text-text-tertiary">
				Create one to get going — a repository is a shared folder where you and
				agents like Claude, ChatGPT, and Gemini work in the same files.
			</p>
		</div>
	);
}

function RepositoryRow({
	organization,
	repository,
	fileCount,
	paletteIndex,
}: {
	organization: Organization;
	repository: Repository;
	fileCount?: number;
	paletteIndex: number;
}) {
	const { getAccessToken } = useAuth();
	const [downloading, setDownloading] = useState(false);
	const path = repositoryPath(organization, repository);
	const palette =
		TILE_PALETTES[paletteIndex % TILE_PALETTES.length] ?? TILE_PALETTES[0];

	const copyUrl = async () => {
		await navigator.clipboard.writeText(
			new URL(path, window.location.origin).href,
		);
		toast.success("Repository URL copied");
	};

	const download = async () => {
		setDownloading(true);
		try {
			const archive = await buildRepositoryArchive({
				namespace: organization.handle,
				repositorySlug: repository.slug,
				getAccessToken,
			});
			triggerBrowserDownload(
				`${repository.slug}.zip`,
				new Blob([archive], { type: "application/zip" }),
			);
			toast.success(`Downloaded ${repository.slug}.zip`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setDownloading(false);
		}
	};

	return (
		<div className="relative flex min-h-[60px] items-center rounded-[10px] px-3.5 transition-colors hover:bg-bg-hover focus-within:bg-bg-hover has-[[data-state=open]]:bg-bg-hover max-[560px]:px-2">
			<Link
				className="flex min-w-0 flex-1 items-center gap-3.5 rounded-lg py-[13px] text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
				to="/@{$namespace}/$repository"
				params={{ namespace: organization.handle, repository: repository.slug }}
				search={{}}
			>
				<span
					className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[9px] text-[13px] font-bold tracking-[-0.01em]"
					style={{
						background: palette.background,
						boxShadow: `inset 0 0 0 1px ${palette.border}`,
						color: palette.color,
					}}
					aria-hidden="true"
				>
					{repositoryInitials(repository.name)}
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] leading-tight font-semibold text-text-primary">
						{repository.name}
					</strong>
					<span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] leading-tight text-text-tertiary">
						{fileCount === undefined ? "…" : fileCount}{" "}
						{pluralize(fileCount ?? 0, "file")} · active{" "}
						{formatRelativeTime(repository.updatedAt)}
					</span>
				</span>
			</Link>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-0 bg-transparent p-0 text-icon-tertiary transition-colors hover:bg-bg-hover hover:text-icon-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible data-[state=open]:bg-bg-hover data-[state=open]:text-icon-secondary [&_svg]:size-[15px] [&_svg]:stroke-[2.3]"
						type="button"
						aria-label={`Actions for ${repository.name}`}
					>
						<Ellipsis aria-hidden="true" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					sideOffset={4}
					className="w-[210px] min-w-[210px] rounded-[10px] border-border-panel bg-bg-panel p-[5px] shadow-lg [&_[data-slot=dropdown-menu-item]]:gap-[9px] [&_[data-slot=dropdown-menu-item]]:rounded-[7px] [&_[data-slot=dropdown-menu-item]]:px-2.5 [&_[data-slot=dropdown-menu-item]]:py-2 [&_[data-slot=dropdown-menu-item]]:text-[13px] [&_[data-slot=dropdown-menu-item]]:leading-tight [&_[data-slot=dropdown-menu-item]]:text-text-secondary [&_[data-slot=dropdown-menu-item]:focus]:bg-bg-hover [&_[data-slot=dropdown-menu-item]_svg]:size-3.5 [&_[data-slot=dropdown-menu-item]_svg]:text-icon-tertiary [&_[data-slot=dropdown-menu-separator]]:mx-2 [&_[data-slot=dropdown-menu-separator]]:my-[5px] [&_[data-slot=dropdown-menu-separator]]:bg-border-subtle [&_[data-variant=destructive]]:text-error-700 [&_[data-variant=destructive]:focus]:bg-error-50 [&_[data-variant=destructive]:focus]:text-error-700"
				>
					<DropdownMenuItem asChild>
						<Link
							to="/@{$namespace}/$repository/settings"
							params={{
								namespace: organization.handle,
								repository: repository.slug,
							}}
						>
							<Settings aria-hidden="true" />
							Settings
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => void copyUrl()}>
						<Link2 aria-hidden="true" />
						Copy URL
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={downloading}
						onSelect={() => void download()}
					>
						<Download aria-hidden="true" />
						{downloading ? "Preparing archive…" : "Download archive"}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/**
 * "New repository" dialog for hosts outside the directory (e.g. the
 * workspace repository picker). Pass the writable organizations; the first
 * one is preselected.
 */
export function CreateRepositoryDialog({
	open,
	organizations,
	onClose,
}: {
	open: boolean;
	organizations: Array<Organization>;
	onClose: () => void;
}) {
	// The inner dialog resets its fields when the `dialog` object changes, so
	// keep a stable identity while open.
	const dialog = useMemo<DialogState>(
		() => (open ? { type: "create" } : null),
		[open],
	);
	return (
		<RepositoryDialog
			dialog={dialog}
			organizations={organizations}
			onClose={onClose}
		/>
	);
}

function RepositoryDialog({
	dialog,
	organizations,
	onClose,
}: {
	dialog: DialogState;
	organizations: Array<Organization>;
	onClose: () => void;
}) {
	const { createRepository, deleteRepository, renameRepository } =
		useRepository();
	const defaultOrganizationId = organizations[0]?.id ?? "";
	const [name, setName] = useState("");
	const [organizationId, setOrganizationId] = useState(defaultOrganizationId);
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [creatingOrganization, setCreatingOrganization] = useState(false);

	useEffect(() => {
		setName(dialog?.type === "rename" ? dialog.repository.name : "");
		setOrganizationId(
			dialog && dialog.type !== "create"
				? dialog.organization.id
				: (dialog?.organizationId ?? defaultOrganizationId),
		);
		setConfirmation("");
		setError(null);
		setBusy(false);
	}, [defaultOrganizationId, dialog]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!dialog) return;
		setBusy(true);
		setError(null);
		try {
			if (dialog.type === "create") {
				await createRepository(name, organizationId);
				toast.success(`Created “${name.trim()}”`);
			} else if (dialog.type === "rename") {
				await renameRepository(dialog.repository.id, name);
				toast.success(`Renamed to “${name.trim()}”`);
			} else {
				await deleteRepository(dialog.repository.id);
				toast.success(`Deleted “${dialog.repository.name}”`);
			}
			onClose();
		} catch (caught) {
			setError(formatCaughtError(caught));
			setBusy(false);
		}
	};

	const isDelete = dialog?.type === "delete";
	const title =
		dialog?.type === "create"
			? "New repository"
			: dialog?.type === "rename"
				? `Rename ${dialog.repository.name}`
				: dialog?.type === "delete"
					? `Delete ${dialog.repository.name}?`
					: "Repository";

	return (
		<Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="border-border-panel bg-bg-panel shadow-lg">
				<form className="grid gap-5" onSubmit={(event) => void submit(event)}>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{isDelete
								? "This removes the repository from your directory and keeps its name reserved."
								: dialog?.type === "rename"
									? "The repository URL stays the same."
									: "A shared folder for your team and agents — any file type, every change tracked."}
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2" data-testid="repository-dialog-fields">
						{dialog?.type === "create" && !isDemoModeEnabled ? (
							<>
								<div className="flex h-11 items-center rounded-lg border border-border-panel bg-bg-panel pr-2.5 pl-3 focus-within:ring-2 focus-within:ring-ring-focus-visible focus-within:ring-offset-1">
									<span className="relative inline-flex h-full shrink-0 cursor-pointer items-center gap-0.5 text-[13.5px] font-semibold text-text-primary">
										@
										{organizations.find(
											(organization) => organization.id === organizationId,
										)?.handle ?? "…"}
										<ChevronDown
											className="size-3.5 text-icon-tertiary"
											aria-hidden="true"
										/>
										<select
											aria-label="Account"
											className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
											value={organizationId}
											onChange={(event) => {
												if (event.target.value === CREATE_ORGANIZATION_OPTION) {
													setCreatingOrganization(true);
													return;
												}
												setOrganizationId(event.target.value);
											}}
										>
											{organizations.map((organization) => (
												<option key={organization.id} value={organization.id}>
													@{organization.handle}
												</option>
											))}
											<option value={CREATE_ORGANIZATION_OPTION}>
												+ New organization…
											</option>
										</select>
									</span>
									<span
										className="px-1 text-[13.5px] text-text-quaternary"
										aria-hidden="true"
									>
										/
									</span>
									<input
										aria-label="Repository name"
										className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-quaternary"
										autoFocus
										maxLength={80}
										placeholder="repository-name"
										value={name}
										onChange={(event) => setName(event.target.value)}
									/>
								</div>
							</>
						) : null}

						{isDelete ? (
							<label className="grid gap-2">
								<span className="text-[13px] font-semibold text-text-secondary">
									Type <strong>{dialog.repository.name}</strong> to confirm
								</span>
								<input
									className="h-10 w-full rounded-lg border border-border-panel bg-bg-panel px-[11px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1"
									autoFocus
									value={confirmation}
									onChange={(event) => setConfirmation(event.target.value)}
								/>
							</label>
						) : dialog?.type === "rename" ||
						  (dialog?.type === "create" && isDemoModeEnabled) ? (
							<label className="grid gap-2">
								<span className="text-[13px] font-semibold text-text-secondary">
									Repository name
								</span>
								<input
									className="h-10 w-full rounded-lg border border-border-panel bg-bg-panel px-[11px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1"
									autoFocus
									maxLength={80}
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
							</label>
						) : null}
						{error ? (
							<p
								className="m-0 rounded-lg bg-error-50 px-3 py-2.5 text-[13px] text-error-700"
								role="alert"
							>
								{error}
							</p>
						) : null}
					</div>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant={isDelete ? "destructive" : "featured"}
							className={isDelete ? undefined : "font-bold"}
							disabled={
								busy ||
								(isDelete
									? confirmation !== dialog.repository.name
									: !name.trim() || !organizationId)
							}
						>
							{busy
								? "Saving…"
								: isDelete
									? "Delete repository"
									: dialog?.type === "rename"
										? "Rename"
										: "Create repository"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
			<CreateOrganizationDialog
				open={creatingOrganization}
				onClose={() => setCreatingOrganization(false)}
				onCreated={(newOrganizationId) => setOrganizationId(newOrganizationId)}
			/>
		</Dialog>
	);
}

/** Sentinel option value in the namespace select that opens the org dialog. */
const CREATE_ORGANIZATION_OPTION = "__create-organization__";

function DirectoryStatus({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary">
			<AppTitlebar>
				<AppTitlebarBrand href="/" />
			</AppTitlebar>
			<DirectoryStatusContent>{children}</DirectoryStatusContent>
		</div>
	);
}

function DirectoryStatusContent({ children }: { children: ReactNode }) {
	return (
		<main className="grid min-h-0 flex-1 place-content-center justify-items-center gap-3.5 bg-bg-app p-6 text-center text-text-secondary [&_h1]:max-w-[520px] [&_h1]:text-[28px]">
			{children}
		</main>
	);
}

function SignedOutDirectory() {
	return (
		<div className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary">
			<AppTitlebar>
				<AppTitlebarBrand />
			</AppTitlebar>
			<DirectoryStatusContent>
				<h1>Sign in to see your repositories.</h1>
				<Button asChild variant="secondary">
					<Link to="/sign-in">Sign in</Link>
				</Button>
			</DirectoryStatusContent>
		</div>
	);
}

export function pluralize(
	count: number,
	singular: string,
	plural?: string,
): string {
	return count === 1 ? singular : (plural ?? `${singular}s`);
}
