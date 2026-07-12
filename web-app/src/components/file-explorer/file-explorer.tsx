import { useNavigate, useSearch } from "@tanstack/react-router";
import { FolderOpen, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
	DirectoryNotFoundError,
	type ExplorerEntry,
	normalizeDirPath,
	type UploadItem,
	UploadError,
	useFileExplorerApi,
} from "~/lib/file-explorer-api";
import { triggerBrowserDownload } from "~/lib/download";
import { formatCaughtError } from "~/lib/format";
import type { Branch } from "~/lib/lixray-api";
import { collectDroppedItems } from "./drop-items";
import { DeleteDialog } from "./delete-dialog";
import { EntryTable } from "./entry-table";
import { ExplorerBreadcrumb } from "./explorer-breadcrumb";
import { ExplorerToolbar } from "./explorer-toolbar";
import { NameDialog } from "./name-dialog";

const WARN_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

type DialogState =
	| { type: "new-folder" }
	| { type: "rename"; entry: ExplorerEntry }
	| { type: "delete"; entries: Array<ExplorerEntry> }
	| null;

export function FileExplorer({
	workspaceName,
	namespace,
	workspaceSlug,
}: {
	workspaceName: string;
	namespace: string;
	workspaceSlug: string;
}) {
	const api = useFileExplorerApi();
	const navigate = useNavigate();
	const search = useSearch({ from: "/@{$namespace}/$workspace" });
	const dirPath = normalizeDirPath(search.dir);

	const [branches, setBranches] = useState<Array<Branch>>([]);
	const [activeBranchId, setActiveBranchId] = useState("");
	const [entries, setEntries] = useState<Array<ExplorerEntry> | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [dialog, setDialog] = useState<DialogState>(null);
	const [busy, setBusy] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const dragDepth = useRef(0);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);

	const loadBranches = useCallback(async () => {
		try {
			const response = await api.listBranches();
			setBranches(response.branches);
			setActiveBranchId((current) => {
				if (
					current &&
					response.branches.some((branch) => branch.id === current)
				) {
					return current;
				}
				return (
					response.branches.find((branch) => branch.name === "main")?.id ??
					response.branches[0]?.id ??
					""
				);
			});
		} catch (caught) {
			setListError(formatCaughtError(caught));
		}
	}, [api]);

	useEffect(() => {
		void loadBranches();
	}, [loadBranches]);

	const refresh = useCallback(async () => {
		if (!activeBranchId) {
			return;
		}
		setListError(null);
		try {
			setEntries(await api.listDirectory(activeBranchId, dirPath));
		} catch (caught) {
			if (caught instanceof DirectoryNotFoundError) {
				toast.error("Folder not found.");
				void navigate({
					to: "/@{$namespace}/$workspace",
					params: { namespace, workspace: workspaceSlug },
					search: {},
				});
				return;
			}
			setListError(formatCaughtError(caught));
		}
	}, [api, activeBranchId, dirPath, namespace, navigate, workspaceSlug]);

	useEffect(() => {
		setEntries(null);
		setSelected(new Set());
		void refresh();
	}, [refresh]);

	const uploadItems = async (
		items: Array<UploadItem>,
		emptyDirPaths: Array<string> = [],
	) => {
		if (!activeBranchId || (items.length === 0 && emptyDirPaths.length === 0)) {
			return;
		}
		const oversize = items.find((item) => item.bytes.length > MAX_FILE_BYTES);
		if (oversize) {
			toast.error(
				`“${oversize.relativePath}” is larger than 64 MB and cannot be uploaded.`,
			);
			return;
		}
		if (items.some((item) => item.bytes.length > WARN_FILE_BYTES)) {
			toast.warning("Uploading large files may take a while.");
		}
		setBusy(true);
		try {
			if (emptyDirPaths.length > 0) {
				await api.ensureDirectories(
					activeBranchId,
					emptyDirPaths.map((relative) => `${dirPath}${relative}`),
				);
			}
			if (items.length > 0) {
				await api.uploadFiles(activeBranchId, dirPath, items);
			}
			toast.success(
				items.length === 1
					? `Uploaded “${items[0].relativePath}”`
					: `Uploaded ${items.length} files`,
			);
		} catch (caught) {
			if (caught instanceof UploadError) {
				toast.error(
					`Uploaded ${caught.uploaded} of ${caught.total} files: ${caught.message}`,
				);
			} else {
				toast.error(formatCaughtError(caught));
			}
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	const onInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		const items = await Promise.all(
			files.map(async (file) => ({
				relativePath: file.webkitRelativePath || file.name,
				bytes: new Uint8Array(await file.arrayBuffer()),
			})),
		);
		await uploadItems(items);
	};

	const onDrop = async (event: React.DragEvent) => {
		event.preventDefault();
		dragDepth.current = 0;
		setDragOver(false);
		if (busy || !activeBranchId) {
			return;
		}
		const dropped = await collectDroppedItems(event.dataTransfer);
		const items = await Promise.all(
			dropped.files.map(async ({ relativePath, file }) => ({
				relativePath,
				bytes: new Uint8Array(await file.arrayBuffer()),
			})),
		);
		await uploadItems(items, dropped.emptyDirPaths);
	};

	const downloadEntries = async (toDownload: Array<ExplorerEntry>) => {
		if (!activeBranchId || toDownload.length === 0) {
			return;
		}
		setBusy(true);
		try {
			const [first] = toDownload;
			if (toDownload.length === 1 && first.kind === "file") {
				const bytes = await api.fetchFileBytes(activeBranchId, first.id);
				triggerBrowserDownload(first.name, new Blob([bytes]));
				toast.success(`Downloaded “${first.name}”`);
			} else {
				const zipName =
					toDownload.length === 1 ? `${first.name}.zip` : "lixray-files.zip";
				const bytes = await api.buildZip(activeBranchId, toDownload);
				triggerBrowserDownload(
					zipName,
					new Blob([bytes], { type: "application/zip" }),
				);
				toast.success(`Downloaded ${zipName}`);
			}
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setBusy(false);
		}
	};

	const confirmDelete = (toDelete: Array<ExplorerEntry>) => {
		setDialog(null);
		if (!activeBranchId) {
			return;
		}
		void (async () => {
			setBusy(true);
			try {
				await api.deleteEntries(activeBranchId, toDelete);
				setSelected(new Set());
				toast.success(
					toDelete.length === 1
						? `Deleted “${toDelete[0].name}”`
						: `Deleted ${toDelete.length} items`,
				);
			} catch (caught) {
				toast.error(formatCaughtError(caught));
			} finally {
				setBusy(false);
				void refresh();
			}
		})();
	};

	const selectedEntries =
		entries?.filter((entry) => selected.has(entry.id)) ?? [];

	return (
		<>
			<section className="mb-[18px] max-w-[760px]">
				<p className="mt-0 mb-2 text-[13px] font-bold tracking-[0.08em] text-text-link uppercase">
					{workspaceName}
				</p>
				<h1 className="m-0 text-2xl leading-[1.2]">Files</h1>
			</section>
			<div
				data-testid="file-explorer"
				className="relative rounded-xl border bg-card text-card-foreground shadow-sm"
				onDragEnter={(event) => {
					if (!event.dataTransfer.types.includes("Files")) {
						return;
					}
					event.preventDefault();
					dragDepth.current += 1;
					setDragOver(true);
				}}
				onDragOver={(event) => {
					if (event.dataTransfer.types.includes("Files")) {
						event.preventDefault();
					}
				}}
				onDragLeave={() => {
					dragDepth.current = Math.max(0, dragDepth.current - 1);
					if (dragDepth.current === 0) {
						setDragOver(false);
					}
				}}
				onDrop={(event) => void onDrop(event)}
			>
				<div className="flex flex-col gap-3 border-b p-4">
					<ExplorerToolbar
						branches={branches}
						activeBranchId={activeBranchId}
						onBranchChange={setActiveBranchId}
						selectedCount={selected.size}
						busy={busy}
						onNewFolder={() => setDialog({ type: "new-folder" })}
						onUploadFiles={() => fileInputRef.current?.click()}
						onUploadFolder={() => folderInputRef.current?.click()}
						onDownloadSelected={() => void downloadEntries(selectedEntries)}
						onDeleteSelected={() =>
							setDialog({ type: "delete", entries: selectedEntries })
						}
						onClearSelection={() => setSelected(new Set())}
					/>
					<ExplorerBreadcrumb
						dirPath={dirPath}
						namespace={namespace}
						workspaceSlug={workspaceSlug}
					/>
				</div>
				<div className="min-h-64">
					{listError ? (
						<div className="flex flex-col items-start gap-3 p-6">
							<p role="alert" className="text-sm text-destructive">
								{listError}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => void refresh()}
							>
								Retry
							</Button>
						</div>
					) : entries === null ? (
						<div className="space-y-3 p-4" aria-hidden="true">
							<Skeleton className="h-9 w-full" />
							<Skeleton className="h-9 w-full" />
							<Skeleton className="h-9 w-full" />
						</div>
					) : entries.length === 0 ? (
						<div
							data-testid="explorer-empty"
							className="flex flex-col items-center justify-center gap-2 py-16 text-center"
						>
							<FolderOpen
								aria-hidden="true"
								className="size-8 text-muted-foreground"
							/>
							<p className="text-sm font-medium">This folder is empty</p>
							<p className="text-sm text-muted-foreground">
								Drag files here, or use the Upload button.
							</p>
						</div>
					) : (
						<EntryTable
							entries={entries}
							namespace={namespace}
							workspaceSlug={workspaceSlug}
							selected={selected}
							onSelectedChange={setSelected}
							onDownload={(entry) => void downloadEntries([entry])}
							onRename={(entry) => setDialog({ type: "rename", entry })}
							onDelete={(entry) =>
								setDialog({ type: "delete", entries: [entry] })
							}
						/>
					)}
				</div>
				{dragOver ? (
					<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80">
						<div className="flex items-center gap-2 text-sm font-medium">
							<Upload aria-hidden="true" className="size-4" />
							Drop to upload to {dirPath === "/" ? "Home" : dirPath}
						</div>
					</div>
				) : null}
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					data-testid="upload-file-input"
					onChange={(event) => void onInputChange(event)}
				/>
				<input
					ref={folderInputRef}
					type="file"
					hidden
					data-testid="upload-folder-input"
					{...({ webkitdirectory: "" } as object)}
					onChange={(event) => void onInputChange(event)}
				/>
			</div>
			<NameDialog
				open={dialog?.type === "new-folder"}
				title="New folder"
				description="Create a folder in the current directory."
				initialValue="Untitled folder"
				submitLabel="Create"
				onOpenChange={(open) => !open && setDialog(null)}
				onSubmit={async (name) => {
					await api.createDirectory(activeBranchId, dirPath, name);
					toast.success(`Created “${name}”`);
					void refresh();
				}}
			/>
			<NameDialog
				open={dialog?.type === "rename"}
				title={`Rename ${dialog?.type === "rename" && dialog.entry.kind === "dir" ? "folder" : "file"}`}
				description="Enter a new name."
				initialValue={dialog?.type === "rename" ? dialog.entry.name : ""}
				submitLabel="Rename"
				onOpenChange={(open) => !open && setDialog(null)}
				onSubmit={async (name) => {
					if (dialog?.type !== "rename") {
						return;
					}
					await api.renameEntry(activeBranchId, dialog.entry, name);
					toast.success(`Renamed to “${name}”`);
					void refresh();
				}}
			/>
			<DeleteDialog
				entries={dialog?.type === "delete" ? dialog.entries : []}
				onOpenChange={(open) => !open && setDialog(null)}
				onConfirm={() => {
					if (dialog?.type === "delete") {
						confirmDelete(dialog.entries);
					}
				}}
			/>
		</>
	);
}
