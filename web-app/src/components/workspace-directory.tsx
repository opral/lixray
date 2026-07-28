import { Link } from "@tanstack/react-router";
import {
	Download,
	Ellipsis,
	Link2,
	LogOut,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import {
	type Organization,
	type Workspace,
	useWorkspace,
} from "~/components/workspace-provider";
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
	buildWorkspaceArchive,
	fetchWorkspaceFileCount,
} from "~/lib/workspace-archive";
import { workspacePath } from "~/lib/workspace-url";

type DialogState =
	| { type: "create" }
	| { type: "rename"; organization: Organization; workspace: Workspace }
	| { type: "delete"; organization: Organization; workspace: Workspace }
	| null;

const TILE_PALETTES = [
	{
		background: "var(--color-bg-selection-current)",
		border: "var(--color-border-selection-current)",
		color: "var(--color-icon-selection-current)",
	},
	{ background: "#eff2e9", border: "#dce3cc", color: "#5a7052" },
	{ background: "#ebf0f4", border: "#d3dfe8", color: "#4a6b85" },
	{ background: "#f3eef6", border: "#e2d7e9", color: "#7a5e8c" },
] as const;

export function WorkspaceDirectory() {
	const auth = useAuth();
	const workspaceState = useWorkspace();
	const [dialog, setDialog] = useState<DialogState>(null);
	const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
	const signedIn = isDemoModeEnabled || Boolean(auth.user);
	const organizations = workspaceState.organizations;
	const writableOrganizations = organizations.filter(
		(organization) => organization.role !== null,
	);

	useEffect(() => {
		let cancelled = false;
		setFileCounts({});
		for (const organization of organizations) {
			for (const workspace of organization.workspaces) {
				void fetchWorkspaceFileCount({
					namespace: organization.handle,
					workspaceSlug: workspace.slug,
					getAccessToken: auth.getAccessToken,
				})
					.then((count) => {
						if (!cancelled) {
							setFileCounts((current) => ({
								...current,
								[workspace.id]: count,
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

	if ((!isDemoModeEnabled && !auth.isLoaded) || !workspaceState.isLoaded) {
		return <DirectoryStatus>Loading workspaces…</DirectoryStatus>;
	}
	if (!signedIn) return <SignedOutDirectory />;
	if (workspaceState.error) {
		return (
			<DirectoryStatus>
				<span>{workspaceState.error}</span>
				<Button
					variant="featured"
					className="font-bold"
					onClick={() => void workspaceState.refresh()}
				>
					Try again
				</Button>
			</DirectoryStatus>
		);
	}

	const workspaceCount = organizations.reduce(
		(total, organization) => total + organization.workspaces.length,
		0,
	);
	const namespaceCount = organizations.filter(
		(organization) => organization.workspaces.length > 0,
	).length;
	const paletteOrder = new Map(
		organizations
			.flatMap((organization) => organization.workspaces)
			.map((workspace, index) => [workspace.id, index] as const),
	);
	return (
		<div
			className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary"
			data-testid="workspace-directory"
		>
			<DirectoryHeader />
			<main className="flex min-h-0 flex-1 justify-center overflow-auto">
				<section
					className="w-[min(920px,calc(100%-32px))] pt-14 pb-[60px] max-[560px]:w-[min(100%-20px,920px)] max-[560px]:pt-[34px]"
					aria-labelledby="workspaces-title"
				>
					<div className="flex items-center gap-4 px-3.5 pb-1.5 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:px-2">
						<h1
							className="m-0 text-[27px] leading-[1.2] font-bold tracking-[-0.02em]"
							id="workspaces-title"
						>
							Workspaces
						</h1>
						<Button
							variant="featured"
							className="ml-auto h-9 gap-1.5 px-3.5 text-[13.5px] font-bold max-[560px]:ml-0 max-[560px]:self-start"
							data-testid="new-workspace-button"
							type="button"
							disabled={writableOrganizations.length === 0}
							onClick={() => setDialog({ type: "create" })}
						>
							<Plus className="size-3.5" aria-hidden="true" />
							New workspace
						</Button>
					</div>
					{workspaceCount > 0 ? (
						<p className="m-0 px-3.5 pb-[30px] text-[13.5px] leading-normal text-text-tertiary max-[560px]:px-2 max-[560px]:pt-1 max-[560px]:pb-6">
							{workspaceCount} {pluralize(workspaceCount, "workspace")} across{" "}
							{namespaceCount} {pluralize(namespaceCount, "namespace")}
						</p>
					) : null}

					{workspaceCount === 0 ? (
						<WorkspaceEmptyState />
					) : (
						organizations.map((organization, groupIndex) =>
							organization.workspaces.length > 0 ? (
								<section
									className="pt-[26px] data-[first=true]:pt-0"
									data-first={groupIndex === 0 || undefined}
									key={organization.id}
									aria-labelledby={`namespace-${organization.id}`}
								>
									<h2
										className="m-0 px-3.5 pb-2 text-[11.5px] leading-[1.35] font-bold tracking-[0.08em] text-text-tertiary uppercase max-[560px]:px-2"
										id={`namespace-${organization.id}`}
									>
										{organization.handle}
									</h2>
									<div className="flex flex-col">
										{organization.workspaces.map((workspace) => (
											<WorkspaceRow
												key={workspace.id}
												organization={organization}
												workspace={workspace}
												fileCount={fileCounts[workspace.id]}
												paletteIndex={paletteOrder.get(workspace.id) ?? 0}
												canManage={organization.role !== null}
												onRename={() =>
													setDialog({ type: "rename", organization, workspace })
												}
												onDelete={() =>
													setDialog({ type: "delete", organization, workspace })
												}
											/>
										))}
									</div>
								</section>
							) : null,
						)
					)}
				</section>
			</main>

			<WorkspaceDialog
				dialog={dialog}
				organizations={writableOrganizations}
				onClose={() => setDialog(null)}
			/>
		</div>
	);
}

function DirectoryHeader() {
	const { signOut, user } = useAuth();
	const initial = isDemoModeEnabled ? "M" : accountInitial(user?.user_metadata);

	return (
		<AppTitlebar>
			<AppTitlebarBrand />
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						className="ml-auto inline-flex size-[26px] cursor-pointer items-center justify-center rounded-full border-0 bg-bg-action-secondary p-0 text-[11px] font-semibold text-text-on-action-secondary transition hover:-translate-y-px hover:bg-bg-action-secondary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
						type="button"
						aria-label="Account menu"
					>
						{initial}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="min-w-[190px] border-border-panel bg-bg-panel"
				>
					{isDemoModeEnabled ? null : (
						<DropdownMenuItem onSelect={() => void signOut()}>
							<LogOut aria-hidden="true" />
							Sign out
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</AppTitlebar>
	);
}

function WorkspaceEmptyState() {
	return (
		<div
			className="grid min-h-[480px] place-content-center justify-items-center px-4 pb-16 text-center max-[560px]:min-h-[400px] max-[560px]:pb-8"
			data-testid="workspace-empty-state"
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
				No workspaces yet
			</h2>
			<p className="mt-2 mb-0 max-w-[480px] text-[14px] leading-[1.5] text-text-tertiary">
				Create one to get going — a workspace is a shared folder where you and
				agents like Claude, ChatGPT, and Gemini work in the same files.
			</p>
		</div>
	);
}

function WorkspaceRow({
	organization,
	workspace,
	fileCount,
	paletteIndex,
	canManage,
	onRename,
	onDelete,
}: {
	organization: Organization;
	workspace: Workspace;
	fileCount?: number;
	paletteIndex: number;
	canManage: boolean;
	onRename: () => void;
	onDelete: () => void;
}) {
	const { getAccessToken } = useAuth();
	const [downloading, setDownloading] = useState(false);
	const path = workspacePath(organization, workspace);
	const palette =
		TILE_PALETTES[paletteIndex % TILE_PALETTES.length] ?? TILE_PALETTES[0];

	const copyUrl = async () => {
		await navigator.clipboard.writeText(
			new URL(path, window.location.origin).href,
		);
		toast.success("Workspace URL copied");
	};

	const download = async () => {
		setDownloading(true);
		try {
			const archive = await buildWorkspaceArchive({
				namespace: organization.handle,
				workspaceSlug: workspace.slug,
				getAccessToken,
			});
			triggerBrowserDownload(
				`${workspace.slug}.zip`,
				new Blob([archive], { type: "application/zip" }),
			);
			toast.success(`Downloaded ${workspace.slug}.zip`);
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
				to="/@{$namespace}/$workspace"
				params={{ namespace: organization.handle, workspace: workspace.slug }}
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
					{workspaceInitials(workspace.name)}
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] leading-tight font-semibold text-text-primary">
						{workspace.name}
					</strong>
					<span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] leading-tight text-text-tertiary">
						{fileCount === undefined ? "…" : fileCount}{" "}
						{pluralize(fileCount ?? 0, "file")} · active{" "}
						{formatRelativeTime(workspace.updatedAt)}
					</span>
				</span>
			</Link>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-0 bg-transparent p-0 text-icon-tertiary transition-colors hover:bg-bg-hover hover:text-icon-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible data-[state=open]:bg-bg-hover data-[state=open]:text-icon-secondary [&_svg]:size-[15px] [&_svg]:stroke-[2.3]"
						type="button"
						aria-label={`Actions for ${workspace.name}`}
					>
						<Ellipsis aria-hidden="true" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					sideOffset={4}
					className="w-[210px] min-w-[210px] rounded-[10px] border-border-panel bg-bg-panel p-[5px] shadow-lg [&_[data-slot=dropdown-menu-item]]:gap-[9px] [&_[data-slot=dropdown-menu-item]]:rounded-[7px] [&_[data-slot=dropdown-menu-item]]:px-2.5 [&_[data-slot=dropdown-menu-item]]:py-2 [&_[data-slot=dropdown-menu-item]]:text-[13px] [&_[data-slot=dropdown-menu-item]]:leading-tight [&_[data-slot=dropdown-menu-item]]:text-text-secondary [&_[data-slot=dropdown-menu-item]:focus]:bg-bg-hover [&_[data-slot=dropdown-menu-item]_svg]:size-3.5 [&_[data-slot=dropdown-menu-item]_svg]:text-icon-tertiary [&_[data-slot=dropdown-menu-separator]]:mx-2 [&_[data-slot=dropdown-menu-separator]]:my-[5px] [&_[data-slot=dropdown-menu-separator]]:bg-border-subtle [&_[data-variant=destructive]]:text-error-700 [&_[data-variant=destructive]:focus]:bg-error-50 [&_[data-variant=destructive]:focus]:text-error-700"
				>
					{canManage ? (
						<DropdownMenuItem onSelect={onRename}>
							<Pencil aria-hidden="true" />
							Rename
						</DropdownMenuItem>
					) : null}
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
					{canManage ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onSelect={onDelete}>
								<Trash2 aria-hidden="true" />
								Delete workspace…
							</DropdownMenuItem>
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function WorkspaceDialog({
	dialog,
	organizations,
	onClose,
}: {
	dialog: DialogState;
	organizations: Array<Organization>;
	onClose: () => void;
}) {
	const { createWorkspace, deleteWorkspace, renameWorkspace } = useWorkspace();
	const defaultOrganizationId = organizations[0]?.id ?? "";
	const [name, setName] = useState("");
	const [organizationId, setOrganizationId] = useState(defaultOrganizationId);
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setName(dialog?.type === "rename" ? dialog.workspace.name : "");
		setOrganizationId(
			dialog && dialog.type !== "create"
				? dialog.organization.id
				: defaultOrganizationId,
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
				await createWorkspace(name, organizationId);
				toast.success(`Created “${name.trim()}”`);
			} else if (dialog.type === "rename") {
				await renameWorkspace(dialog.workspace.id, name);
				toast.success(`Renamed to “${name.trim()}”`);
			} else {
				await deleteWorkspace(dialog.workspace.id);
				toast.success(`Deleted “${dialog.workspace.name}”`);
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
			? "New workspace"
			: dialog?.type === "rename"
				? `Rename ${dialog.workspace.name}`
				: dialog?.type === "delete"
					? `Delete ${dialog.workspace.name}?`
					: "Workspace";

	return (
		<Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="border-border-panel bg-bg-panel shadow-lg">
				<form className="grid gap-5" onSubmit={(event) => void submit(event)}>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{isDelete
								? "This removes the workspace from your directory and keeps its name reserved."
								: dialog?.type === "rename"
									? "The workspace URL stays the same."
									: "Choose a namespace and give the workspace a name."}
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2" data-testid="workspace-dialog-fields">
						{dialog?.type === "create" && organizations.length > 1 ? (
							<label className="grid gap-2">
								<span className="text-[13px] font-semibold text-text-secondary">
									Namespace
								</span>
								<select
									className="h-10 w-full rounded-lg border border-border-panel bg-bg-panel px-[11px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1"
									value={organizationId}
									onChange={(event) => setOrganizationId(event.target.value)}
								>
									{organizations.map((organization) => (
										<option key={organization.id} value={organization.id}>
											@{organization.handle}
										</option>
									))}
								</select>
							</label>
						) : null}

						{isDelete ? (
							<label className="grid gap-2">
								<span className="text-[13px] font-semibold text-text-secondary">
									Type <strong>{dialog.workspace.name}</strong> to confirm
								</span>
								<input
									className="h-10 w-full rounded-lg border border-border-panel bg-bg-panel px-[11px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1"
									autoFocus
									value={confirmation}
									onChange={(event) => setConfirmation(event.target.value)}
								/>
							</label>
						) : (
							<label className="grid gap-2">
								<span className="text-[13px] font-semibold text-text-secondary">
									Workspace name
								</span>
								<input
									className="h-10 w-full rounded-lg border border-border-panel bg-bg-panel px-[11px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1"
									autoFocus
									maxLength={80}
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
							</label>
						)}
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
									? confirmation !== dialog.workspace.name
									: !name.trim() || !organizationId)
							}
						>
							{busy
								? "Saving…"
								: isDelete
									? "Delete workspace"
									: dialog?.type === "rename"
										? "Rename"
										: "Create workspace"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DirectoryStatus({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary">
			<AppTitlebar>
				<AppTitlebarBrand />
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
				<h1>Sign in to see your workspaces.</h1>
				<Button asChild variant="secondary">
					<Link to="/sign-in">Sign in</Link>
				</Button>
			</DirectoryStatusContent>
		</div>
	);
}

function workspaceInitials(name: string): string {
	const parts = name.match(/[a-z0-9]+/gi) ?? [];
	if (parts.length === 0) return "W";
	const first = parts[0] ?? "W";
	if (parts.length === 1) return first.slice(0, 2).toUpperCase();
	return `${first.charAt(0)}${(parts[1] ?? "").charAt(0)}`.toUpperCase();
}

function pluralize(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function accountInitial(metadata: Record<string, unknown> | undefined): string {
	const value = metadata?.full_name ?? metadata?.name;
	return typeof value === "string" && value.trim()
		? value.trim().charAt(0).toUpperCase()
		: "M";
}
