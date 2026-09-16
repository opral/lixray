import type { Lix } from "@lix-js/sdk";
import { DiffGlyph } from "@opral/atelier";
import { fileIconUrl } from "@opral/atelier/file-icons";
import {
	Check,
	ChevronRight,
	FolderOpen,
	House,
	Download,
	FolderInput,
	GripVertical,
	MoreHorizontal,
	Minus,
	PencilLine,
	Trash2,
	X,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
} from "react";
import {
	Button as AriaButton,
	Checkbox,
	DIRECTORY_DRAG_TYPE,
	GridList,
	GridListItem,
	Toolbar,
	useDragAndDrop,
	type GridListItemRenderProps,
	type DropItem,
	type Selection,
} from "react-aria-components";
import { DropdownMenu } from "radix-ui";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	deleteWorkspaceEntries,
	downloadWorkspaceEntries,
	importWorkspaceEntries,
	moveWorkspaceEntries,
	renameWorkspaceEntry,
	type WorkspaceImportEntry,
} from "./directory-operations";
import {
	formatUpdatedAt,
	listDirectory,
	type RepositoryTree,
} from "./lix-data";

const ENTRY_TYPE = "application/x-lixray-entry";
// Only drags produced by this mounted repository view may move its entries.
const dragScopes = new WeakMap<Lix, string>();
function scopeFor(lix: Lix) {
	let scope = dragScopes.get(lix);
	if (!scope) {
		scope = crypto.randomUUID();
		dragScopes.set(lix, scope);
	}
	return scope;
}

async function readImportItems(
	items: DropItem[],
	prefix = "",
): Promise<WorkspaceImportEntry[]> {
	const entries: WorkspaceImportEntry[] = [];
	for (const item of items) {
		if (item.kind === "file")
			entries.push({
				kind: "file",
				path: `${prefix}${item.name}`,
				file: await item.getFile(),
			});
		if (item.kind === "directory") {
			const path = `${prefix}${item.name}`;
			entries.push({ kind: "directory", path });
			for await (const child of item.getEntries())
				entries.push(...(await readImportItems([child], `${path}/`)));
		}
	}
	return entries;
}

export function DirectoryFileList({
	lix,
	tree,
	dirPath,
	readOnly,
	onOpenFile,
	onOpenDir,
	listing,
	changedFileKinds,
	changedDirKinds,
	reviewFocus = false,
	viewingHistory = false,
	onOpenDiffFile,
	onContextMenu,
}: {
	lix: Lix;
	tree: RepositoryTree;
	dirPath: string;
	readOnly: boolean;
	onOpenFile: (path: string, options: { newTab: boolean }) => void;
	onOpenDir: (path: string, options: { newTab: boolean }) => void;
	listing: ReturnType<typeof listDirectory>;
	changedFileKinds: ReadonlyMap<
		string,
		"added" | "modified" | "removed" | "moved"
	>;
	changedDirKinds: ReadonlyMap<string, "added" | "modified">;
	reviewFocus?: boolean;
	viewingHistory?: boolean;
	onOpenDiffFile?: (path: string) => void;
	onContextMenu?: (
		entry: { directory: boolean; name: string; path: string; id?: string },
		event: ReactMouseEvent,
	) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const restoreFocus = useCallback(() => {
		listRef.current
			?.querySelector<HTMLElement>(
				'[role="row"][aria-selected="true"], [role="row"], [role="grid"]',
			)
			?.focus();
	}, []);
	const moveEntries = (sources: string[], target: string) =>
		moveWorkspaceEntries(lix, sources, target);
	const renameEntry = (path: string, name: string) =>
		renameWorkspaceEntry(lix, path, name);
	const entries = useMemo(
		() => [
			...listing.dirs.map((dir) => ({
				...dir,
				directory: true,
				meta: `${dir.itemCount} ${dir.itemCount === 1 ? "item" : "items"}`,
			})),
			...listing.files.map((file) => ({
				...file,
				directory: false,
				meta: formatUpdatedAt(file.updatedAt),
			})),
		],
		[listing],
	);
	const [selection, setSelection] = useState<Selection>(new Set());
	const paths = entries
		.filter((entry) => selection === "all" || selection.has(entry.path))
		.map((entry) => entry.path);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState("");
	const [dialog, setDialog] = useState<"move" | "rename" | "delete" | null>(
		null,
	);
	const [menuOpen, setMenuOpen] = useState(false);
	const [destination, setDestination] = useState(dirPath);
	const dragPaths = useRef<string[]>([]);
	useEffect(() => {
		if (!paths.length) return;
		// Only a popup the user can see owns the gesture: a hidden tab's
		// listbox or a row's own context menu must not keep the selection.
		const hasActiveInteraction = () =>
			busyRef.current ||
			dialog !== null ||
			menuOpen ||
			dragPaths.current.length > 0 ||
			[
				...document.querySelectorAll(
					'[role="dialog"], [role="alertdialog"], [role="menu"]:not([data-entry-context-menu]), [role="listbox"]',
				),
			].some((element) => element.getClientRects().length > 0);
		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0 || hasActiveInteraction()) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (
				listRef.current?.contains(target) &&
				target.closest('[role="row"], [role="toolbar"]')
			)
				return;
			setSelection(new Set());
		};
		const onEscape = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.isComposing ||
				event.defaultPrevented ||
				hasActiveInteraction()
			)
				return;
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest(
					'textarea, input:not([type="checkbox"]), [contenteditable="true"]',
				)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			setSelection(new Set());
			if (target instanceof Node && listRef.current?.contains(target)) {
				requestAnimationFrame(restoreFocus);
			}
		};
		// Capture also reaches checkboxes and toolbar controls that consume key events.
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onEscape, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onEscape, true);
		};
	}, [paths.length, dialog, menuOpen, restoreFocus]);
	const scope = scopeFor(lix);
	const open = (path: string, newTab = false) => {
		const entry = entries.find((item) => item.path === path);
		if (entry?.directory) onOpenDir(path, { newTab });
		// Inside a review a marked row opens its diff, which is what the
		// reader came for. Outside one the same mark only says "something
		// changed here", and a click still opens the file.
		else if (
			entry &&
			!newTab &&
			reviewFocus &&
			changedFileKinds.has(path) &&
			onOpenDiffFile
		)
			onOpenDiffFile(path);
		else if (entry) onOpenFile(path, { newTab });
	};
	const run = async (
		operation: () => Promise<unknown>,
		message = "",
		clear = true,
	) => {
		if (busyRef.current) return false;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		setStatus("");
		try {
			await operation();
			if (clear) setSelection(new Set());
			setDialog(null);
			setStatus(message);
			return true;
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Something went wrong. Please try again.",
			);
			return false;
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	const drop = async (items: DropItem[], target: string) => {
		if (readOnly || busyRef.current) return;
		await run(async () => {
			const internal = items.filter(
				(item) => item.kind === "text" && item.types.has(ENTRY_TYPE),
			);
			if (internal.length) {
				const moved: string[] = [];
				for (const item of internal) {
					if (item.kind !== "text") continue;
					const data: unknown = JSON.parse(await item.getText(ENTRY_TYPE));
					if (
						!data ||
						typeof data !== "object" ||
						!("scope" in data) ||
						data.scope !== scope ||
						!("path" in data) ||
						typeof data.path !== "string"
					)
						throw new Error("Move files within the same repository.");
					moved.push(data.path);
				}
				await moveEntries(moved, target);
			} else {
				const importedEntries = await readImportItems(items);
				if (!importedEntries.length)
					throw new Error("Drop files or folders to import.");
				const result = await importWorkspaceEntries(
					lix,
					target,
					importedEntries,
				);
				if (result.failed.length)
					throw new Error(
						`Could not import: ${result.failed.join(", ")}. Existing items were kept.`,
					);
			}
		});
	};
	const { dragAndDropHooks } = useDragAndDrop({
		isDisabled: readOnly || busy,
		getItems(keys) {
			dragPaths.current = [...keys].map(String);
			return dragPaths.current.map((path) => ({
				[ENTRY_TYPE]: JSON.stringify({ scope, path }),
				"text/plain": path,
			}));
		},
		getAllowedDropOperations: () => ["move"],
		shouldAcceptItemDrop: (target) =>
			entries.some((entry) => entry.path === target.key && entry.directory),
		getDropOperation(target, types) {
			if (readOnly || busy) return "cancel";
			const path = target.type === "root" ? dirPath : String(target.key);
			if (
				target.type === "item" &&
				(target.dropPosition !== "on" ||
					!entries.some((entry) => entry.path === path && entry.directory))
			)
				return "cancel";
			// Safari treats unknown file types as matching every MIME type.
			if (types.has(ENTRY_TYPE) && !types.has(DIRECTORY_DRAG_TYPE)) {
				if (
					dragPaths.current.some(
						(source) =>
							source === path ||
							(entries.some(
								(entry) => entry.directory && entry.path === source,
							) &&
								path.startsWith(`${source}/`)),
					)
				)
					return "cancel";
				return "move";
			}
			// Browser files expose MIME types; validate actual file/directory items on drop.
			return "copy";
		},
		onRootDrop: (event) => {
			void drop(event.items, dirPath);
		},
		onItemDrop: (event) => {
			void drop(event.items, String(event.target.key));
		},
		onDragEnd: () => {
			dragPaths.current = [];
		},
	});
	const destinations = [
		{ path: "/", name: "Home" },
		...tree.dirs.map((dir) => ({
			path: dir.path,
			name: dir.path.slice(1),
		})),
	].filter(
		(dir) =>
			!entries.some(
				(entry) =>
					entry.directory &&
					paths.includes(entry.path) &&
					(dir.path === entry.path || dir.path.startsWith(`${entry.path}/`)),
			),
	);
	return (
		<div
			ref={listRef}
			className="relative flex flex-col gap-2"
			onKeyDown={(event) => {
				if (
					busyRef.current ||
					readOnly ||
					!(event.target instanceof HTMLElement) ||
					!event.target.closest('[data-testid="home-entry-list"]') ||
					event.target.closest("button,input,textarea,select")
				)
					return;
				if (event.key === "F2" && paths.length === 1) {
					event.preventDefault();
					setError(null);
					setDialog("rename");
				}
				if (event.key === "Delete" && paths.length) {
					event.preventDefault();
					setError(null);
					setDialog("delete");
				}
			}}
		>
			{paths.length > 0 ? (
				<Toolbar
					aria-label="Selection actions"
					className="absolute bottom-full @min-[640px]:left-[calc(-2.25rem-5px)] z-20 mb-3 flex max-w-full items-center divide-x divide-border rounded-lg border border-border bg-panel text-fg-muted shadow-[0_2px_8px_color-mix(in_srgb,var(--at-overlay)_8%,transparent)] @max-[640px]:fixed @max-[640px]:bottom-6 @max-[640px]:left-1/2 @max-[640px]:mb-0 @max-[640px]:w-max @max-[640px]:max-w-[calc(100vw-24px)] @max-[640px]:-translate-x-1/2"
				>
					<div className="flex items-center gap-1 pl-1 pr-3">
						<Checkbox
							aria-label={
								paths.length === entries.length
									? "Deselect all files and folders"
									: "Select all files and folders"
							}
							isSelected={paths.length === entries.length}
							isIndeterminate={paths.length < entries.length}
							isDisabled={busy}
							onChange={() => {
								if (paths.length === entries.length) {
									setSelection(new Set());
									requestAnimationFrame(restoreFocus);
								} else {
									setSelection(new Set(entries.map((entry) => entry.path)));
								}
							}}
							className="grid size-8 shrink-0 cursor-pointer place-items-center rounded outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[disabled]:opacity-50"
						>
							{({ isIndeterminate }) => (
								<span className="grid size-4 place-items-center rounded border border-link bg-link text-accent-on">
									{isIndeterminate ? (
										<Minus aria-hidden="true" className="size-3" />
									) : (
										<Check aria-hidden="true" className="size-3" />
									)}
								</span>
							)}
						</Checkbox>
						<span
							className="whitespace-nowrap py-2 text-sm font-medium text-link"
							aria-live="polite"
						>
							{paths.length} selected
						</span>
					</div>
					{!readOnly ? (
						<AriaButton
							isDisabled={busy}
							onPress={() => {
								setError(null);
								setDestination(dirPath);
								setDialog("move");
							}}
							className="flex h-9 items-center gap-2 px-3 text-sm outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
						>
							<FolderInput className="size-4" />
							Move
						</AriaButton>
					) : null}
					<DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
						<DropdownMenu.Trigger asChild>
							<AriaButton
								aria-label="More selection actions"
								isDisabled={busy}
								className="grid size-9 place-items-center outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
							>
								<MoreHorizontal className="size-4" />
							</AriaButton>
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								align="start"
								sideOffset={6}
								className="z-50 min-w-44 rounded-lg border border-border bg-panel p-1 text-sm text-fg-muted shadow-lg"
							>
								<DropdownMenu.Item
									className="cursor-default rounded px-3 py-2 outline-none data-[highlighted]:bg-bg-hover"
									onSelect={() => paths.forEach((path) => open(path, true))}
								>
									Open in new tabs
								</DropdownMenu.Item>
								<DropdownMenu.Item
									disabled={viewingHistory}
									className="flex cursor-default items-center gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-bg-hover data-[disabled]:opacity-50"
									onSelect={() =>
										void run(
											() => downloadWorkspaceEntries(lix, paths),
											"Download ready.",
											false,
										)
									}
								>
									<Download className="size-4" />
									Download
								</DropdownMenu.Item>
								{!readOnly && paths.length === 1 ? (
									<DropdownMenu.Item
										className="flex cursor-default items-center gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-bg-hover"
										onSelect={() => {
											setError(null);
											setDialog("rename");
										}}
									>
										<PencilLine className="size-4" />
										Rename
									</DropdownMenu.Item>
								) : null}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
					{!readOnly ? (
						<AriaButton
							aria-label="Delete"
							isDisabled={busy}
							onPress={() => {
								setError(null);
								setDialog("delete");
							}}
							className="grid size-9 place-items-center outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
						>
							<Trash2 className="size-4" />
						</AriaButton>
					) : null}
					<AriaButton
						aria-label="Clear selection"
						isDisabled={busy}
						onPress={() => {
							setSelection(new Set());
							restoreFocus();
						}}
						className="grid size-9 place-items-center rounded-r-lg outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
					>
						<X className="size-4" />
					</AriaButton>
				</Toolbar>
			) : null}
			{error && !dialog ? (
				<p role="alert" className="px-3 text-sm text-danger-border">
					{error}
				</p>
			) : null}
			<div
				role="status"
				className={busy || status ? "px-3 text-xs text-fg-subtle" : "sr-only"}
			>
				{busy ? "Working…" : status}
			</div>
			{/* React Aria fixes its drag hook configuration for each collection mount. */}
			<GridList
				key={readOnly ? "read-only" : "editable"}
				aria-label="Files and folders"
				items={entries}
				selectionMode="multiple"
				selectionBehavior="toggle"
				selectedKeys={selection}
				onSelectionChange={(next) => {
					if (!busyRef.current) setSelection(next);
				}}
				onAction={(key) => {
					if (!busyRef.current) open(String(key));
				}}
				dragAndDropHooks={readOnly ? undefined : dragAndDropHooks}
				aria-busy={busy}
				data-testid="home-entry-list"
				dependencies={[
					busy,
					readOnly,
					paths.length > 0,
					changedFileKinds,
					changedDirKinds,
					reviewFocus,
				]}
				className="-ml-6 sm:-ml-9 flex min-h-24 flex-col gap-px rounded-lg outline-none data-[drop-target]:bg-bg-hover data-[drop-target]:ring-2 data-[drop-target]:ring-ring"
				renderEmptyState={() => (
					<div className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-fg-subtle">
						{readOnly
							? "No files yet."
							: "This folder is empty. Create something with New, or drop files and folders here."}
					</div>
				)}
			>
				{(entry) => {
					const changeKind = entry.directory
						? changedDirKinds.get(entry.path)
						: changedFileKinds.get(entry.path);
					const dimIndicator = entry.directory && changeKind === "modified";
					const nameClass =
						dimIndicator || !changeKind
							? "text-fg"
							: changeKind === "added"
								? "text-diff-added"
								: changeKind === "removed"
									? "text-diff-removed"
									: changeKind === "modified"
										? "text-link"
										: "text-diff-moved";
					return (
						<GridListItem
							id={entry.path}
							textValue={entry.name}
							data-path={entry.path}
							data-testid={entry.directory ? undefined : "home-file-entry"}
							data-file-id={"id" in entry ? entry.id : undefined}
							data-hidden-entry={entry.hidden ? "true" : undefined}
							data-changed-entry={changeKind ? "true" : undefined}
							onContextMenu={(event) => {
								if (!readOnly && !busyRef.current) {
									setSelection(new Set([entry.path]));
									onContextMenu?.(entry, event);
								}
							}}
							className={`group relative flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-lg py-2 pl-9 sm:pl-12 pr-3 text-sm outline-none transition-opacity before:pointer-events-none before:absolute before:inset-y-0 before:left-6 sm:before:left-9 before:right-0 before:-z-10 before:rounded-lg isolate hover:before:bg-bg-hover data-[selected]:before:bg-bg-active data-[focus-visible]:before:ring-2 data-[focus-visible]:before:ring-inset data-[focus-visible]:before:ring-ring data-[drop-target]:before:bg-bg-active data-[drop-target]:before:ring-2 data-[drop-target]:before:ring-ring ${entry.hidden ? "opacity-[0.48] hover:opacity-[0.62]" : reviewFocus && !changeKind ? "opacity-[0.35] hover:opacity-100" : ""}`}
						>
							{({ state }) => (
								<>
									<FileSelectionCheckbox
										state={state}
										path={entry.path}
										name={entry.name}
										busy={busy}
										selectionActive={paths.length > 0}
									/>
									<img
										src={
											entry.directory
												? "/icon-sq-folder.svg"
												: fileIconUrl(entry.name)
										}
										alt=""
										draggable={false}
										className="size-[19px] shrink-0"
									/>
									<span
										className={`min-w-0 flex-1 truncate font-medium ${nameClass}`}
										title={entry.name}
										data-testid={
											entry.directory ? undefined : "home-entry-name"
										}
									>
										{entry.name}
									</span>
									{changeKind ? (
										<DiffGlyph
											kind={changeKind}
											className={`shrink-0 ${dimIndicator ? "opacity-75" : ""}`}
										/>
									) : (
										<span className="shrink-0 text-xs text-fg-faint">
											{entry.meta}
										</span>
									)}
									{!readOnly ? (
										<AriaButton
											slot="drag"
											aria-label={`Drag ${entry.name}`}
											className="grid size-6 shrink-0 cursor-grab place-items-center rounded text-fg-faint opacity-0 outline-none group-hover:opacity-100 group-data-[focus-visible]:opacity-100 group-data-[focus-visible-within]:opacity-100 data-[focus-visible]:opacity-100 focus-visible:ring-2"
										>
											<GripVertical className="size-3.5" />
										</AriaButton>
									) : null}
								</>
							)}
						</GridListItem>
					);
				}}
			</GridList>
			<NameEntryDialog
				open={dialog === "rename"}
				title="Rename"
				onRestoreFocus={restoreFocus}
				initialName={
					entries.find((entry) => entry.path === paths[0])?.name ?? ""
				}
				busy={busy}
				error={error}
				onClose={() => setDialog(null)}
				onSubmit={(name) => {
					if (paths[0] && !readOnly)
						void run(() => renameEntry(paths[0]!, name), "Renamed.");
				}}
			/>
			<Dialog
				open={dialog === "move" || dialog === "delete"}
				onOpenChange={(open) => {
					if (!open && !busy) setDialog(null);
				}}
			>
				<DialogContent
					showCloseButton={!busy}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						restoreFocus();
					}}
					className="gap-0 overflow-hidden rounded-[12px] border-border bg-panel p-0 text-fg shadow-lg sm:max-w-[480px]"
				>
					<DialogHeader className="gap-1.5 px-6 pt-6 pb-5 text-left">
						<DialogTitle>
							{dialog === "move" ? "Move" : "Delete"} {paths.length}{" "}
							{paths.length === 1 ? "item" : "items"}
						</DialogTitle>
						<DialogDescription>
							{dialog === "move"
								? "Choose where these items should live."
								: "Folders and everything inside them will be deleted. Their history remains available."}
						</DialogDescription>
					</DialogHeader>
					{dialog === "move" ? (
						<MoveFolderBrowser
							destinations={destinations}
							destination={destination}
							currentDirectory={dirPath}
							busy={busy}
							onNavigate={setDestination}
						/>
					) : null}
					{error ? (
						<p role="alert" className="px-6 pb-4 text-sm text-danger-border">
							{error}
						</p>
					) : null}
					<div className="flex justify-end gap-2 border-t border-border px-6 py-4">
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setDialog(null)}
						>
							Cancel
						</Button>
						<Button
							disabled={
								busy ||
								readOnly ||
								!paths.length ||
								(dialog === "move" &&
									(destination === dirPath ||
										!destinations.some((dir) => dir.path === destination)))
							}
							onClick={() =>
								void run(
									() =>
										dialog === "move"
											? moveEntries(paths, destination)
											: deleteWorkspaceEntries(lix, paths),
									dialog === "move" ? "Items moved." : "Items deleted.",
								)
							}
						>
							{busy ? "Working…" : dialog === "move" ? "Move here" : "Delete"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function MoveFolderBrowser({
	destinations,
	destination,
	currentDirectory,
	busy,
	onNavigate,
}: {
	destinations: { path: string; name: string }[];
	destination: string;
	currentDirectory: string;
	busy: boolean;
	onNavigate: (path: string) => void;
}) {
	const segments = destination.split("/").filter(Boolean);
	const breadcrumbs = [
		{ path: "/", name: "Home" },
		...segments.map((name, index) => ({
			path: `/${segments.slice(0, index + 1).join("/")}`,
			name,
		})),
	];
	const folders = destinations
		.filter(
			(dir) =>
				dir.path !== "/" &&
				(dir.path.slice(0, dir.path.lastIndexOf("/")) || "/") === destination,
		)
		.map((dir) => ({ ...dir, name: dir.path.split("/").at(-1)! }));
	const hasAlternative = destinations.some(
		(dir) => dir.path !== currentDirectory,
	);
	return (
		<div className="px-6 pb-5">
			<nav
				aria-label="Destination location"
				className="mb-2 flex min-h-9 items-center gap-1 overflow-x-auto text-sm"
			>
				{breadcrumbs.map((crumb, index) => (
					<span key={crumb.path} className="flex shrink-0 items-center gap-1">
						{index > 0 ? (
							<ChevronRight
								aria-hidden="true"
								className="size-3.5 text-fg-subtle"
							/>
						) : null}
						<AriaButton
							isDisabled={busy}
							aria-current={crumb.path === destination ? "location" : undefined}
							onPress={() => onNavigate(crumb.path)}
							className="flex max-w-56 items-center gap-2 rounded-md px-2 py-1.5 text-fg-muted outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:font-medium aria-[current=location]:text-fg disabled:opacity-50"
						>
							{index === 0 ? (
								<House aria-hidden="true" className="size-3.5" />
							) : null}
							<span className="truncate">{crumb.name}</span>
						</AriaButton>
					</span>
				))}
			</nav>
			<GridList
				aria-label="Destination folders"
				items={folders}
				selectionMode="none"
				disabledKeys={busy ? folders.map((dir) => dir.path) : []}
				onAction={(key) => onNavigate(String(key))}
				className="h-52 overflow-y-auto rounded-lg border border-border p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				renderEmptyState={() => (
					<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
						<FolderOpen
							aria-hidden="true"
							className="mb-1 size-7 text-fg-subtle"
							strokeWidth={1.5}
						/>
						<p className="text-sm font-medium text-fg-muted">
							{hasAlternative
								? "No folders inside"
								: "No other folders available"}
						</p>
						<p className="max-w-72 text-xs leading-relaxed text-fg-subtle">
							{destination !== currentDirectory
								? "You can move your items here."
								: hasAlternative
									? "Use the breadcrumb above to choose another folder."
									: "Selected folders can’t be destinations. Select fewer items or create a destination folder first."}
						</p>
					</div>
				)}
			>
				{(folder) => (
					<GridListItem
						id={folder.path}
						textValue={folder.name}
						className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none hover:bg-bg-hover data-[focus-visible]:bg-bg-hover data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-ring data-[disabled]:opacity-50"
					>
						<img src="/icon-sq-folder.svg" alt="" className="size-5 shrink-0" />
						<span className="min-w-0 flex-1 truncate">{folder.name}</span>
						<ChevronRight
							aria-hidden="true"
							className="size-4 shrink-0 text-fg-subtle"
						/>
					</GridListItem>
				)}
			</GridList>
			<p aria-live="polite" className="mt-3 text-xs text-fg-subtle">
				{destination === currentDirectory
					? "These items are already in this folder."
					: `Move to ${segments.at(-1) ?? "Home"}`}
			</p>
		</div>
	);
}

function FileSelectionCheckbox({
	state,
	path,
	name,
	busy,
	selectionActive,
}: {
	path: string;
	name: string;
	busy: boolean;
	selectionActive: boolean;
	state: GridListItemRenderProps["state"];
}) {
	const shift = useRef(false);
	return (
		<Checkbox
			slot={null}
			isDisabled={busy}
			isSelected={state.selectionManager.isSelected(path)}
			aria-label={`Select ${name}`}
			onPointerDownCapture={(event) => {
				shift.current = event.shiftKey;
			}}
			onKeyDown={(event) => {
				shift.current = event.shiftKey;
			}}
			onChange={() => {
				// Keep range anchors inside React Aria's selection manager, including
				// when a checkbox range is followed by a Shift-click on a row.
				if (shift.current) state.selectionManager.extendSelection(path);
				else state.selectionManager.toggleSelection(path);
				shift.current = false;
			}}
			className={`absolute left-0 grid size-8 cursor-pointer place-items-center rounded outline-none transition-opacity data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring ${selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-data-[focus-visible]:opacity-100 group-data-[focus-visible-within]:opacity-100 data-[focus-visible]:opacity-100 [@media(hover:none)]:opacity-100"}`}
		>
			{({ isSelected }) => (
				<span
					className={`grid size-4 place-items-center rounded border ${isSelected ? "border-link bg-link text-accent-on" : "border-border bg-panel"}`}
				>
					{isSelected ? <Check className="size-3" /> : null}
				</span>
			)}
		</Checkbox>
	);
}

export function NameEntryDialog({
	open,
	onRestoreFocus,
	title,
	initialName,
	busy,
	error,
	onClose,
	onSubmit,
}: {
	open: boolean;
	onRestoreFocus?: () => void;
	title: string;
	initialName: string;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSubmit: (name: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onClose();
			}}
		>
			<DialogContent
				showCloseButton={!busy}
				className="bg-panel text-fg"
				onCloseAutoFocus={(event) => {
					if (onRestoreFocus) {
						event.preventDefault();
						onRestoreFocus();
					}
				}}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					inputRef.current?.focus();
					inputRef.current?.select();
				}}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						Choose a name. Press Enter to save or Escape to cancel.
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						const name = inputRef.current?.value.trim();
						if (name && !busy) onSubmit(name);
					}}
					className="flex flex-col gap-4"
				>
					<label className="flex flex-col gap-2 text-sm">
						Name
						<input
							ref={inputRef}
							aria-label={title === "New folder" ? "Folder name" : "Name"}
							defaultValue={initialName}
							required
							disabled={busy}
							maxLength={255}
							aria-invalid={!!error}
							aria-describedby={error ? "entry-name-error" : undefined}
							className="h-10 w-full rounded-lg border border-border bg-panel px-3 outline-none focus:ring-2 focus:ring-ring"
						/>
					</label>
					{error ? (
						<p
							id="entry-name-error"
							role="alert"
							className="text-sm text-danger-border"
						>
							{error}
						</p>
					) : null}
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>
							{busy
								? "Saving…"
								: title === "New folder"
									? "Create folder"
									: "Save"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
