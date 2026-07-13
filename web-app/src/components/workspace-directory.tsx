import { Link } from "@tanstack/react-router";
import {
	Check,
	Copy,
	Download,
	Ellipsis,
	Link2,
	LogOut,
	Pencil,
	Plus,
	Settings,
	Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
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

	useEffect(() => {
		let cancelled = false;
		setFileCounts({});
		for (const workspace of organizations.flatMap(
			(organization) => organization.workspaces,
		)) {
			void fetchWorkspaceFileCount(workspace.id, auth.getAccessToken)
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
				<Button onClick={() => void workspaceState.refresh()}>Try again</Button>
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
	const firstWorkspace = organizations
		.flatMap((organization) =>
			organization.workspaces.map((workspace) => ({ organization, workspace })),
		)
		.at(0);

	return (
		<div
			className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary"
			data-testid="workspace-directory"
		>
			<DirectoryHeader />
			<main className="flex min-h-0 flex-1 justify-center overflow-auto">
				<section
					className="w-[min(720px,calc(100%-32px))] pt-14 pb-[60px] max-[560px]:w-[min(100%-20px,720px)] max-[560px]:pt-[34px]"
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
							className="ml-auto max-[560px]:ml-0 max-[560px]:self-start"
							data-testid="new-workspace-button"
							type="button"
							disabled={organizations.length === 0}
							onClick={() => setDialog({ type: "create" })}
						>
							<Plus aria-hidden="true" />
							New workspace
						</Button>
					</div>
					<p className="m-0 px-3.5 pb-[30px] text-[13.5px] leading-normal text-text-tertiary max-[560px]:px-2 max-[560px]:pt-1 max-[560px]:pb-6">
						{workspaceCount} {pluralize(workspaceCount, "workspace")} across{" "}
						{namespaceCount} {pluralize(namespaceCount, "namespace")}
					</p>

					{organizations.length === 0 ? (
						<div className="mx-3.5 mt-3 rounded-xl border border-border-panel bg-bg-panel/45 p-[34px] text-center">
							<h2 className="m-0 text-[17px]">Create a namespace first</h2>
							<p className="mt-[7px] mb-0 text-[13px] text-text-tertiary">
								Workspaces live inside a namespace.
							</p>
							<Link
								className="mt-4 inline-block text-[13px] font-semibold text-text-link hover:text-text-link-hover"
								to="/workspace"
							>
								Open workspace settings
							</Link>
						</div>
					) : workspaceCount === 0 ? (
						<div className="mx-3.5 mt-3 rounded-xl border border-border-panel bg-bg-panel/45 p-[34px] text-center">
							<h2 className="m-0 text-[17px]">No workspaces yet</h2>
							<p className="mt-[7px] mb-0 text-[13px] text-text-tertiary">
								Create one to start working with files.
							</p>
						</div>
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

					{firstWorkspace ? (
						<McpQuickstart
							organization={firstWorkspace.organization}
							workspace={firstWorkspace.workspace}
						/>
					) : null}
				</section>
			</main>

			<WorkspaceDialog
				dialog={dialog}
				organizations={organizations}
				onClose={() => setDialog(null)}
			/>
		</div>
	);
}

function McpQuickstart({
	organization,
	workspace,
}: {
	organization: Organization;
	workspace: Workspace;
}) {
	const [origin, setOrigin] = useState("");
	const [copied, setCopied] = useState(false);

	useEffect(() => setOrigin(window.location.origin), []);

	const mcpUrl = `${origin || "http://localhost:8787"}/mcp`;
	const isLocalhost = (() => {
		try {
			return ["localhost", "127.0.0.1", "::1"].includes(
				new URL(origin || "http://localhost:8787").hostname,
			);
		} catch {
			return false;
		}
	})();
	const mcpServerName = isLocalhost ? "LixRay-Localhost" : "LixRay";
	const workspaceUrl = `${origin || "http://localhost:8787"}${workspacePath(
		organization,
		workspace,
	)}`;
	const instructions = `Set up LixRay for me end to end in Codex. Use a global MCP server named "${mcpServerName}" with the exact URL ${mcpUrl}. First inspect the existing MCP configuration. Reuse it only if both its name and URL match exactly. If it is missing or points to another URL, create or replace that registration using ${mcpUrl} and complete its OAuth connection. Do not reuse a production LixRay connection for this localhost workspace. Ask me only when an authorization approval must be clicked. If a newly connected MCP server requires a fresh Codex task, create that task and continue the setup there.

Use this exact workspace:
- Name: ${workspace.name}
- Namespace: ${organization.handle}
- Workspace ID: ${workspace.id}
- Preview: ${workspaceUrl}

Call list_workspaces through "${mcpServerName}" and confirm that it returns the exact workspace ID ${workspace.id}. Do not use a workspace ID remembered from another task or conversation. If this ID is unavailable, stop, reconnect "${mcpServerName}" at ${mcpUrl}, and run list_workspaces again before continuing.

Open the workspace preview at ${workspaceUrl}. Do not create or edit any files yet. When everything is ready, tell me the workspace is connected and ask what document I would like you to create. After any future write, read the same file back from workspace ${workspace.id} and confirm its returned revision before reporting that the write succeeded.`;

	const copyInstructions = async () => {
		await navigator.clipboard.writeText(instructions);
		setCopied(true);
		toast.success("Codex setup prompt copied");
		window.setTimeout(() => setCopied(false), 1800);
	};

	return (
		<section
			className="mx-3.5 mt-10 rounded-xl border border-border-panel bg-bg-panel p-5 max-[560px]:mx-2"
			aria-labelledby="mcp-quickstart-title"
		>
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<h2
						className="m-0 text-[16px] font-semibold tracking-[-0.01em]"
						id="mcp-quickstart-title"
					>
						Connect with Codex
					</h2>
					<p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-text-tertiary">
						Paste this prompt into Codex. It will connect Lixray, open your
						workspace, and help you create your first document.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					type="button"
					onClick={() => void copyInstructions()}
				>
					{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
					{copied ? "Copied" : "Copy prompt"}
				</Button>
			</div>
			<pre className="mt-4 mb-0 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-app p-4 font-mono text-[12px] leading-[1.6] text-text-secondary">
				{instructions}
			</pre>
		</section>
	);
}

function DirectoryHeader() {
	const { signOut, user } = useAuth();
	const initial = isDemoModeEnabled ? "M" : accountInitial(user?.user_metadata);

	return (
		<header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border-subtle bg-bg-app px-[22px] max-[560px]:px-4">
			<Link
				className="inline-flex items-center gap-2.5 text-sm font-bold tracking-[-0.01em] text-text-primary no-underline"
				to="/"
				aria-label="Lixray home"
			>
				<img className="size-[19px]" src="/lixray-mark.svg" alt="" />
				<span>lixray</span>
			</Link>
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
					<DropdownMenuItem asChild>
						<Link to="/workspace">
							<Settings aria-hidden="true" />
							Workspace settings
						</Link>
					</DropdownMenuItem>
					{isDemoModeEnabled ? null : (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => void signOut()}>
								<LogOut aria-hidden="true" />
								Sign out
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</header>
	);
}

function WorkspaceRow({
	organization,
	workspace,
	fileCount,
	paletteIndex,
	onRename,
	onDelete,
}: {
	organization: Organization;
	workspace: Workspace;
	fileCount?: number;
	paletteIndex: number;
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
			const archive = await buildWorkspaceArchive(workspace.id, getAccessToken);
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
					<DropdownMenuItem onSelect={onRename}>
						<Pencil aria-hidden="true" />
						Rename
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
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onSelect={onDelete}>
						<Trash2 aria-hidden="true" />
						Delete workspace…
					</DropdownMenuItem>
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
	const [name, setName] = useState("");
	const [organizationId, setOrganizationId] = useState(
		organizations[0]?.id ?? "",
	);
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setName(dialog?.type === "rename" ? dialog.workspace.name : "");
		setOrganizationId(
			dialog && dialog.type !== "create"
				? dialog.organization.id
				: (organizations[0]?.id ?? ""),
		);
		setConfirmation("");
		setError(null);
		setBusy(false);
	}, [dialog, organizations]);

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
							variant={isDelete ? "destructive" : "default"}
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
		<main className="grid min-h-dvh place-content-center justify-items-center gap-3.5 bg-bg-app p-6 text-center text-text-secondary [&_h1]:max-w-[520px] [&_h1]:text-[28px]">
			{children}
		</main>
	);
}

function SignedOutDirectory() {
	return (
		<div className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary">
			<header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border-subtle bg-bg-app px-[22px] max-[560px]:px-4">
				<Link
					className="inline-flex items-center gap-2.5 text-sm font-bold tracking-[-0.01em] text-text-primary no-underline"
					to="/"
				>
					<img className="size-[19px]" src="/lixray-mark.svg" alt="" />
					<span>lixray</span>
				</Link>
			</header>
			<DirectoryStatus>
				<h1>Sign in to see your workspaces.</h1>
				<Button asChild variant="secondary">
					<Link to="/sign-in">Sign in</Link>
				</Button>
			</DirectoryStatus>
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
