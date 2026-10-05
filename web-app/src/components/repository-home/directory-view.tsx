import { AtelierFile } from "@opral/atelier";
import type { Lix } from "@lix-js/sdk";
import {
	deleteWorkspaceEntry,
	ensureDirectoryPath,
	NewFileMenu,
	pickerFolders,
	renameWorkspaceEntry,
	resolveCreateDirectory,
	WorkspacePathTakenError,
} from "@opral/atelier";
import type {
	AtelierDiffSession,
	AtelierDocumentLinks,
	AtelierFileProps,
	DefaultFolderFileType,
	DefaultFolders,
} from "@opral/atelier";
import { fileIconUrl } from "@opral/atelier/file-icons";
import { entityRoutePath } from "~/lib/entity-url";
import {
	ArrowRight,
	ArrowUp,
	Check,
	ChevronDown,
	Copy,
	Database,
	GitCompareArrows,
	Globe2,
	Link2,
	LockKeyhole,
	PencilLine,
	Plus,
	Settings,
	Trash2,
	UserRoundPlus,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	forwardRef,
	type ComponentPropsWithoutRef,
	type DragEvent as ReactDragEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import { Button } from "~/components/ui/button";
import { DirectoryFileList, NameEntryDialog } from "./directory-file-list";
import {
	createNamedWorkspaceFolder,
	collectDroppedWorkspaceEntries,
	importWorkspaceEntries,
} from "./directory-operations";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	createLixConnectionDetails,
	type LixConnectionPromptInput,
} from "~/lib/lix-connection-prompt";
import {
	markRepositoryOpenPerformance,
	REPOSITORY_OPEN_MARKS,
} from "~/lib/repository-open-performance";
import {
	createRepositoryFile,
	describeWorkingChanges,
	listDirectory,
	persistedDirectoryPath,
	resolveRepositoryHref,
	useFileMarkdown,
	useRepositoryControlPlaneData,
	listDirectoryFromFiles,
	useFilesAtCommit,
	useRepositoryTree,
	useWorkingFileChanges,
	type RepositoryControlPlaneData,
	type RepositoryHistorySource,
	type WorkingFileChangeKind,
} from "./lix-data";
import {
	MemberAvatar,
	type TeamMember,
	type RepositoryTeamApi,
} from "./people-view";

type DirectoryViewProps = {
	readonly lix: Lix;
	readonly historySource?: RepositoryHistorySource | null;
	/** The open diff session; its files get change indicators in the listing. */
	readonly diffSession?: AtelierDiffSession | null;
	/** Opens a changed file through the diff session (review-aware). */
	readonly onOpenDiffFile?: (path: string) => void;
	/** Canonical directory path; "/" is the repository home. */
	readonly dirPath: string;
	/** The pinned home shows the connect row. */
	readonly isHome: boolean;
	/**
	 * The Library's Home: the repository's README and its control plane, with
	 * no listing of files — the Library's Files section is the listing.
	 */
	readonly summary?: boolean;
	/** Home: the Library's Recent row, placed under the status line. */
	readonly recent?: ReactNode;
	/** Mirrors the bundled Atelier Files extension's authoritative preference. */
	readonly showHiddenFiles?: boolean;
	/**
	 * Where a new file of each type goes, as the Files view stores it. Home
	 * creates files too, so it obeys and offers the same rule rather than a
	 * second one of its own.
	 */
	readonly defaultFolders?: DefaultFolders;
	/** Absent on a read-only or historical view, where nothing is set. */
	readonly onSetDefaultFolder?: (
		fileType: DefaultFolderFileType,
		folder: string | null,
	) => void;
	readonly readOnly: boolean;
	/** The repository's own file URLs, so README links behave like file rows. */
	readonly documentLinks?: AtelierDocumentLinks;
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	/** Present on the home of an editable repository; drives the Invite control. */
	readonly teamApi?: RepositoryTeamApi | null;
	/** Present on the home tab; drives the Connect agent button. */
	readonly hasAgentConnected?: (() => Promise<boolean>) | null;
	readonly visibility?: "private" | "public";
	/** Only the active view binds shortcuts (several stay mounted hidden). */
	readonly isActive?: boolean;
	readonly onOpenFile: (
		path: string,
		options: { newTab: boolean; created?: boolean },
	) => void;
	readonly onOpenDir: (dirPath: string, options: { newTab: boolean }) => void;
	readonly onOpenPeople?: () => void;
	readonly onOpenSettings?: () => void;
	readonly onOpenSqlExplorer?: () => void;
	readonly onOpenChangesReview?: () => void;
	/** Opens the History view as a normal central tab. */
	readonly onOpenHistory?: () => void;
};

const newTabFromMouseEvent = (event: ReactMouseEvent): boolean =>
	event.metaKey || event.ctrlKey;

/**
 * The repository home / folder view rendered inside Atelier's central tabs.
 * Folders first, then files, then the directory's README rendered below —
 * the tab names the location, so the view carries no title of its own.
 */
/** No folder set for any type: one instance, so memos stay stable. */
const NO_DEFAULT_FOLDERS: DefaultFolders = {};

/** The type each row and each shortcut creates, for the default-folder rule. */
const FILE_TYPE_BY_EXTENSION = {
	md: "markdown",
	csv: "csv",
	excalidraw: "excalidraw",
} as const satisfies Record<string, DefaultFolderFileType>;

const EXTENSION_BY_FILE_TYPE = {
	// "New file" and the ⌘ . shortcut make a Markdown file here, so the plain
	// row follows the plain rule rather than Markdown's.
	generic: "md",
	markdown: "md",
	csv: "csv",
	excalidraw: "excalidraw",
} as const satisfies Record<DefaultFolderFileType, "md" | "csv" | "excalidraw">;

/** Nothing marked: one shared instance keeps the listing's memo stable. */
const EMPTY_CHANGED_FILE_KINDS: ReadonlyMap<string, WorkingFileChangeKind> =
	new Map();

export function DirectoryView({
	lix,
	historySource = null,
	diffSession = null,
	onOpenDiffFile,
	dirPath,
	isHome,
	summary = false,
	recent = null,
	showHiddenFiles = false,
	defaultFolders = NO_DEFAULT_FOLDERS,
	onSetDefaultFolder,
	readOnly,
	documentLinks,
	connection,
	teamApi = null,
	hasAgentConnected = null,
	visibility = "private",
	isActive = true,
	onOpenFile,
	onOpenDir,
	onOpenPeople,
	onOpenSettings,
	onOpenSqlExplorer,
	onOpenChangesReview,
	onOpenHistory,
}: DirectoryViewProps) {
	const [listingAttempt, setListingAttempt] = useState(0);
	const { tree, error: treeError } = useRepositoryTree(
		lix,
		isActive,
		listingAttempt,
	);
	const detailsEnabled = useAfterInitialIdle(
		isActive && isHome && tree !== null,
	);
	const controlPlaneData = useRepositoryControlPlaneData(
		lix,
		historySource,
		detailsEnabled,
	);
	// Time travel: a historical session renders the listing as of its target
	// commit. The working review keeps the live listing — its whole point is
	// the latest state against its actual working baseline.
	const historicalCommitId =
		diffSession && "commitId" in diffSession.target
			? diffSession.target.commitId
			: null;
	const historicalFiles = useFilesAtCommit(
		lix,
		isActive ? historicalCommitId : null,
	);
	const listing = useMemo(() => {
		if (historicalCommitId) {
			return historicalFiles
				? listDirectoryFromFiles(historicalFiles, dirPath, {
						showHiddenFiles,
					})
				: null;
		}
		return tree ? listDirectory(tree, dirPath, { showHiddenFiles }) : null;
	}, [historicalCommitId, historicalFiles, tree, dirPath, showHiddenFiles]);
	// The past is immutable, and the README preview reads live content: both
	// creation affordances and the preview stand down while viewing history.
	const viewingHistory = historicalCommitId !== null;
	// Atelier reconciles file tabs by ID. Folder surfaces retain their own
	// directory ID so moves in another tab (or by a collaborator) keep this
	// surface at the same folder, and deletion returns it to a surviving parent.
	const currentDirectoryRef = useRef<{
		lix: Lix;
		path: string;
		id: string | null;
	} | null>(null);
	useEffect(() => {
		if (!tree || viewingHistory) return;
		const previous = currentDirectoryRef.current;
		const current = tree.dirs.find((directory) => directory.path === dirPath);
		if (
			dirPath === "/" ||
			!previous ||
			previous.lix !== lix ||
			previous.path !== dirPath ||
			current
		) {
			currentDirectoryRef.current = {
				lix,
				path: dirPath,
				id: current?.id ?? null,
			};
			return;
		}
		if (!previous.id || !isActive) return;
		const moved = tree.dirs.find((directory) => directory.id === previous.id);
		let next = moved?.path;
		if (!next) {
			const segments = dirPath.split("/").filter(Boolean);
			do {
				segments.pop();
				next = segments.length ? `/${segments.join("/")}` : "/";
			} while (
				next !== "/" &&
				!tree.dirs.some((directory) => directory.path === next)
			);
		}
		currentDirectoryRef.current = { lix, path: next, id: moved?.id ?? null };
		onOpenDir(next, { newTab: false });
	}, [tree, viewingHistory, dirPath, lix, onOpenDir, isActive]);

	// Per-file change decorations belong to the active review session.
	// Ordinary browsing keeps neutral rows even while working changes exist.
	const sessionFileKinds = useMemo(() => {
		// An open session that names no file says nothing about the listing;
		// the live working diff still can.
		if (!diffSession || diffSession.files.length === 0) return null;
		return new Map(
			diffSession.files.map((file) => [
				file.path,
				file.movedFromPath && file.changeKind === "modified"
					? ("moved" as const)
					: file.changeKind,
			]),
		);
	}, [diffSession]);
	// An active working review may still be preparing its file list. Historical
	// views and ordinary browsing never subscribe to today's working diff.
	const workingFileChangesEnabled = useAfterInitialIdle(
		isActive &&
			tree !== null &&
			diffSession !== null &&
			sessionFileKinds === null &&
			!viewingHistory,
	);
	const workingFileKinds = useWorkingFileChanges(
		lix,
		workingFileChangesEnabled,
	);
	const changedFileKinds = useMemo(
		() =>
			diffSession === null
				? EMPTY_CHANGED_FILE_KINDS
				: (sessionFileKinds ??
					(viewingHistory ? null : workingFileKinds) ??
					EMPTY_CHANGED_FILE_KINDS),
		[diffSession, sessionFileKinds, viewingHistory, workingFileKinds],
	);
	const changedDirKinds = useMemo(() => {
		// Ancestors use the canonical directory convention: absolute, no
		// trailing slash (see canonicalDirectoryPath). A directory whose every
		// file is newly added reads green like its contents; anything mixed
		// keeps the contains-changes orange.
		const dirs = new Map<string, "added" | "modified">();
		for (const path of changedFileKinds.keys()) {
			const segments = path.split("/").filter(Boolean);
			segments.pop();
			let prefix = "";
			for (const segment of segments) {
				prefix = `${prefix}/${segment}`;
				dirs.set(prefix, "modified");
			}
		}
		if (dirs.size === 0) return dirs;
		const allPaths = historicalFiles
			? historicalFiles.map((file) => file.path)
			: (tree?.files.map((file) => file.path) ?? []);
		for (const dirPrefix of dirs.keys()) {
			const prefix = `${dirPrefix}/`;
			let fileCount = 0;
			let allAdded = true;
			for (const path of allPaths) {
				if (!path.startsWith(prefix)) continue;
				fileCount += 1;
				if (changedFileKinds.get(path) !== "added") {
					allAdded = false;
					break;
				}
			}
			if (fileCount > 0 && allAdded) dirs.set(dirPrefix, "added");
		}
		return dirs;
	}, [changedFileKinds, historicalFiles, tree]);
	// Only an active review dims unchanged entries and opens changed rows as diffs.
	const reviewFocus = diffSession !== null && changedFileKinds.size > 0;
	// A changed README previews as its diff — the review renders the change
	// itself, not the resulting document.
	const readmeDiff = useMemo<
		AtelierFileProps | { fileId: string; unavailable: true } | null
	>(() => {
		const readmePath = listing?.readmePath;
		if (!diffSession || !readmePath) return null;
		const file = diffSession.files.find(
			(candidate) => candidate.path === readmePath,
		);
		if (!file || file.changeKind === "removed") return null;
		const baseCommitId =
			file.changeKind !== "added" &&
			diffSession.base &&
			"commitId" in diffSession.base
				? diffSession.base.commitId
				: null;
		const preview = { lix, fileId: file.id, filePath: readmePath };
		if ("commitId" in diffSession.target) {
			return {
				...preview,
				targetCommitId: diffSession.target.commitId,
				diff: { baseCommitId },
			};
		}
		if (!file.workingEpoch) {
			return { unavailable: true, fileId: file.id };
		}
		return { ...preview, diff: { workingEpoch: file.workingEpoch } };
	}, [lix, diffSession, listing?.readmePath]);
	const readme = useFileMarkdown(
		lix,
		listing?.readmePath ?? null,
		detailsEnabled,
	);
	const repositoryTreeMarkedRef = useRef(false);
	const newButtonRef = useRef<HTMLDivElement>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [creatingFolder, setCreatingFolder] = useState(false);
	const creatingFolderRef = useRef(false);
	const [folderError, setFolderError] = useState<string | null>(null);
	const startFolder = useCallback(() => {
		if (readOnly || viewingHistory) return;
		setFolderError(null);
		setNewFolderOpen(true);
	}, [readOnly, viewingHistory]);
	const saveFolder = async (name: string) => {
		if (readOnly || viewingHistory || creatingFolderRef.current) return;
		creatingFolderRef.current = true;
		setCreatingFolder(true);
		setFolderError(null);
		try {
			await createNamedWorkspaceFolder(lix, dirPath, name);
			setNewFolderOpen(false);
		} catch (error) {
			setFolderError(
				error instanceof Error
					? error.message
					: "Unable to create the folder. Try again.",
			);
		} finally {
			creatingFolderRef.current = false;
			setCreatingFolder(false);
		}
	};

	// Right-click file management, sharing the File Explorer's operation
	// semantics through @opral/atelier. Deletion needs no confirmation:
	// lix history makes it recoverable.
	const [entryMenu, setEntryMenu] = useState<{
		kind: "file" | "directory";
		name: string;
		path: string;
		id?: string;
		x: number;
		y: number;
	} | null>(null);
	const [renameTarget, setRenameTarget] = useState<{
		kind: "file" | "directory";
		name: string;
		path: string;
		id?: string;
	} | null>(null);
	useEffect(() => {
		if (!entryMenu) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setEntryMenu(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [entryMenu]);
	const deleteEntry = useCallback(
		(target: { kind: "file" | "directory"; path: string; id?: string }) => {
			if (readOnly || viewingHistory) return;
			setActionError(null);
			void deleteWorkspaceEntry(
				lix,
				target.kind === "file" && target.id
					? { kind: "file", id: target.id }
					: target.kind === "file"
						? { kind: "file", path: target.path }
						: { kind: "directory", path: target.path },
			).catch((error: unknown) => {
				console.error("repository-home: delete failed", error);
				setActionError(
					`Unable to delete the ${target.kind === "file" ? "file" : "folder"}. Try again.`,
				);
			});
		},
		[lix, readOnly, viewingHistory],
	);
	const { isDropTarget, isImporting, dragHandlers } = useImportDrop({
		lix,
		dirPath,
		readOnly: readOnly || viewingHistory,
		onError: setActionError,
	});

	const existingDirectories = useMemo(
		() =>
			new Set(
				(tree?.dirs ?? []).map((directory) =>
					ensureDirectoryPath(directory.path),
				),
			),
		[tree],
	);
	const folderOptions = useMemo(
		() => pickerFolders(existingDirectories, { showHiddenFiles }),
		[existingDirectories, showHiddenFiles],
	);
	const createFile = useCallback(
		async (
			extension: "md" | "csv" | "excalidraw",
			options: {
				/** The row's own type, where it is not the extension's. */
				readonly fileType?: DefaultFolderFileType;
				/** `Create here this time`: the default stands, this file does not. */
				readonly here?: boolean;
			} = {},
		) => {
			const fileType = options.fileType ?? FILE_TYPE_BY_EXTENSION[extension];
			try {
				setActionError(null);
				const path = await createRepositoryFile(
					lix,
					resolveCreateDirectory({
						hereDirectory: dirPath,
						defaultFolder: defaultFolders[fileType],
						existingDirectories,
						...(options.here === true ? { oneOffHere: true } : {}),
					}),
					extension,
				);
				// Every type opens straight into its editor — naming up front is
				// friction. Markdown names itself from the first heading; csv and
				// drawings keep their untitled name until renamed.
				onOpenFile(path, { newTab: false, created: true });
			} catch (error) {
				console.error("repository-home: unable to create file", error);
				setActionError("Unable to create the file. Try again.");
			}
		},
		[defaultFolders, dirPath, existingDirectories, lix, onOpenFile],
	);
	/**
	 * `New folder…` inside the folder picker. The tree's own New folder names
	 * itself inline; this one is named in the picker's field and committed at
	 * once, because the listing is not on screen to type into under a menu.
	 */
	const createFolderAtPath = useCallback(
		async (parentDirectory: string, name: string): Promise<string | null> => {
			try {
				return await createNamedWorkspaceFolder(lix, parentDirectory, name);
			} catch (error) {
				console.error("repository-home: unable to create the folder", error);
				return null;
			}
		},
		[lix],
	);

	// Readiness belongs to the commit that exposes the usable tree. A passive
	// effect can run after paint, leaving visible UI without its readiness mark.
	useLayoutEffect(() => {
		if (!isActive || tree === null || repositoryTreeMarkedRef.current) {
			return;
		}
		repositoryTreeMarkedRef.current = true;
		markRepositoryOpenPerformance(
			REPOSITORY_OPEN_MARKS.treeReady,
			connection.lixId,
		);
	}, [isActive, tree, connection.lixId]);

	useEffect(() => {
		if (!isActive || readOnly || viewingHistory) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!(event.metaKey || event.ctrlKey) ||
				(event.key !== "." && event.code !== "Period") ||
				event.altKey ||
				(event.target instanceof HTMLElement &&
					!!event.target.closest(
						"input,textarea,[contenteditable=true],[role=dialog]",
					))
			) {
				return;
			}
			event.preventDefault();
			setActionError(null);
			if (event.shiftKey) {
				startFolder();
				return;
			}
			void createFile("md", { fileType: "generic" });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [createFile, isActive, readOnly, viewingHistory, startFolder]);

	// The empty repository home renders the welcome pitch as the entire main
	// column — the breadcrumb/New header stands down so "Connect an agent"
	// and "start yourself" are the only calls to action. Empty folders,
	// read-only repos, and history views keep the normal chrome.
	const showGettingStarted = Boolean(
		listing &&
		listing.dirs.length === 0 &&
		listing.files.length === 0 &&
		isHome &&
		dirPath === "/" &&
		!readOnly &&
		!viewingHistory &&
		hasAgentConnected,
	);

	if (!tree || !listing) {
		if (treeError) {
			return (
				<div
					role="alert"
					className="grid h-full w-full place-content-center px-6 text-center text-[13px] text-fg-muted"
				>
					<p>Unable to load repository files.</p>
					<Button
						variant="outline"
						className="mx-auto mt-3"
						onClick={() => setListingAttempt((attempt) => attempt + 1)}
					>
						Retry
					</Button>
				</div>
			);
		}
		return (
			<div
				className="grid h-full w-full place-content-center text-sm text-fg-subtle"
				aria-busy="true"
				role="status"
			>
				Loading files…
			</div>
		);
	}

	// Connect an agent and Invite: in the rail, and above the stats when
	// the rail folds into the page on a narrow screen.
	const teamSection = detailsEnabled ? (
		<>
			{hasAgentConnected ? (
				<ConnectAgentButton
					connection={connection}
					hasAgentConnected={hasAgentConnected}
					disabled={readOnly}
					className={RAIL_CHIP_CLASS}
				/>
			) : null}
			{onOpenPeople ? (
				<InviteControl
					teamApi={teamApi}
					onOpenPeople={onOpenPeople}
					disabled={readOnly || !teamApi}
					className={RAIL_CHIP_CLASS}
				/>
			) : null}
		</>
	) : null;

	return (
		<div
			ref={newButtonRef}
			className={
				summary
					? // Embedded in the Library's Home, which scrolls and frames it.
						"@container relative flex flex-col bg-panel font-sans text-fg"
					: "@container relative flex h-full min-h-0 flex-col overflow-y-auto bg-panel font-sans text-fg"
			}
			{...dragHandlers}
		>
			{isDropTarget ? <DropImportOverlay /> : null}
			<div
				className={
					// Reserve space for the outboard checkboxes and selection toolbar,
					// including when the app shell makes this panel narrower.
					summary
						? "flex flex-col"
						: isHome
							? "mx-auto grid w-[min(1020px,calc(100%-96px))] grid-cols-[minmax(0,1fr)_244px] gap-12 pt-10 pb-10 max-sm:w-[calc(100%-48px)] @max-[1100px]:grid-cols-1 @max-[1100px]:gap-8"
							: "mx-auto flex w-[min(760px,calc(100%-96px))] flex-col pt-10 pb-10 max-sm:w-[calc(100%-48px)]"
				}
			>
				<main
					className={
						// The pitch centers vertically against the rail: main
						// stretches to the shared grid row, whose height the rail's
						// content defines.
						showGettingStarted ? "grid min-w-0 content-center" : "min-w-0"
					}
				>
					{summary && !showGettingStarted ? (
						<HomeStatusLine
							data={controlPlaneData}
							visibility={visibility}
							connection={connection}
							hasAgentConnected={hasAgentConnected}
							readOnly={readOnly}
							invite={
								onOpenPeople && detailsEnabled ? (
									<InviteControl
										teamApi={teamApi}
										onOpenPeople={onOpenPeople}
										disabled={readOnly || !teamApi}
										className={HOME_CHIP_CLASS}
									/>
								) : null
							}
							{...(onOpenChangesReview ? { onOpenChangesReview } : {})}
							{...(onOpenHistory ? { onOpenHistory } : {})}
							{...(onOpenSqlExplorer ? { onOpenSqlExplorer } : {})}
							{...(onOpenSettings ? { onOpenSettings } : {})}
						/>
					) : null}
					{summary && !showGettingStarted && recent ? (
						<div className="pb-10">{recent}</div>
					) : null}
					{showGettingStarted || summary ? null : (
						<div
							className={`flex items-center gap-2 ${summary ? "pb-6" : "pb-5"}`}
						>
							{summary ? (
								<h1 className="m-0 min-w-0 truncate text-[22px] leading-8 font-semibold tracking-[-0.01em] text-fg">
									Home
								</h1>
							) : (
								<Breadcrumb
									dirPath={dirPath}
									onNavigate={(path, event) =>
										onOpenDir(path, { newTab: newTabFromMouseEvent(event) })
									}
								/>
							)}
							<span className="flex-1" />
							<div
								className={`flex shrink-0 items-center gap-2 transition-opacity${
									reviewFocus ? " opacity-[0.35] hover:opacity-100" : ""
								}`}
							>
								{readOnly || viewingHistory ? (
									<NewButton disabled />
								) : (
									<NewFileMenu
										// The button ends the header row; a menu starting
										// where it starts would hang off the column.
										align="end"
										defaultFolders={defaultFolders}
										folderOptions={folderOptions}
										hereDirectory={dirPath}
										existingDirectories={existingDirectories}
										{...(onSetDefaultFolder ? { onSetDefaultFolder } : {})}
										onNewFile={() =>
											void createFile("md", { fileType: "generic" })
										}
										onNewFolder={startFolder}
										onNewMarkdown={() => void createFile("md")}
										onNewCsv={() => void createFile("csv")}
										onNewExcalidraw={() => void createFile("excalidraw")}
										onCreateHereOnce={(fileType) =>
											void createFile(EXTENSION_BY_FILE_TYPE[fileType], {
												fileType,
												here: true,
											})
										}
										onCreateFolder={createFolderAtPath}
									>
										<NewButton />
									</NewFileMenu>
								)}
							</div>
						</div>
					)}
					{actionError ? (
						<p
							role="alert"
							className="mb-3 rounded-lg bg-danger-border/10 px-3 py-2 text-[13px] text-danger-border"
						>
							{actionError}
						</p>
					) : null}
					{showGettingStarted && hasAgentConnected ? (
						<GettingStarted
							connection={connection}
							hasAgentConnected={hasAgentConnected}
							onCreateFile={(extension) => void createFile(extension)}
						/>
					) : summary ? null : (
						<DirectoryFileList
							key={`${dirPath}:${historicalCommitId ?? "live"}`}
							lix={lix}
							tree={tree}
							listing={listing}
							dirPath={dirPath}
							readOnly={readOnly || viewingHistory}
							viewingHistory={viewingHistory}
							changedFileKinds={changedFileKinds}
							changedDirKinds={changedDirKinds}
							reviewFocus={reviewFocus}
							onOpenFile={onOpenFile}
							onOpenDir={onOpenDir}
							{...(onOpenDiffFile ? { onOpenDiffFile } : {})}
							onContextMenu={(entry, event) => {
								event.preventDefault();
								setEntryMenu({
									kind: entry.directory ? "directory" : "file",
									name: entry.name,
									path: entry.path,
									...(entry.id ? { id: entry.id } : {}),
									x: event.clientX,
									y: event.clientY,
								});
							}}
						/>
					)}
					<NameEntryDialog
						open={newFolderOpen}
						title="New folder"
						initialName="Untitled folder"
						busy={creatingFolder}
						error={folderError}
						onClose={() => setNewFolderOpen(false)}
						onSubmit={(name) => void saveFolder(name)}
						onRestoreFocus={() =>
							newButtonRef.current
								?.querySelector<HTMLButtonElement>(
									'[data-testid="home-new-button"]',
								)
								?.focus()
						}
					/>
					{isImporting ? (
						<p role="status" className="px-3 py-2 text-xs text-fg-subtle">
							Importing files and folders…
						</p>
					) : null}
					{isHome && !summary ? (
						<RepositoryNarrowStats
							fileCount={tree.files.length}
							data={controlPlaneData}
							onOpenSqlExplorer={onOpenSqlExplorer}
							onOpenChangesReview={onOpenChangesReview}
							onOpenHistory={onOpenHistory}
							teamSection={teamSection}
							embedded={summary}
						/>
					) : null}
					{summary &&
					!showGettingStarted &&
					!listing.readmePath &&
					!readOnly &&
					!viewingHistory ? (
						<AddReadmeCard
							onCreate={() =>
								void (async () => {
									try {
										setActionError(null);
										await lix.execute(
											"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
											[
												"/README.md",
												new TextEncoder().encode(
													"# README\n\nWhat this repository is for, and how it is organised.\n",
												),
											],
										);
										onOpenFile("/README.md", { newTab: true });
									} catch (error) {
										console.error(
											"repository-home: unable to create README",
											error,
										);
										setActionError("Couldn’t create the README.");
									}
								})()
							}
						/>
					) : null}
					{listing.readmePath && readme !== null && !viewingHistory ? (
						<div
							className={`transition-opacity${
								reviewFocus && !changedFileKinds.has(listing.readmePath)
									? " opacity-[0.35] hover:opacity-100"
									: ""
							}`}
						>
							<ReadmePreview
								section={summary}
								lix={lix}
								sourceFilePath={listing.readmePath}
								fileId={
									readmeDiff?.fileId ??
									tree.files.find((file) => file.path === listing.readmePath)
										?.id ??
									null
								}
								diff={readmeDiff}
								fileName={
									listing.readmePath.split("/").filter(Boolean).at(-1) ?? ""
								}
								{...(documentLinks ? { documentLinks } : {})}
								onOpenLinkedFile={(path) => onOpenFile(path, { newTab: true })}
								onOpen={(event, options) =>
									onOpenFile(listing.readmePath as string, {
										newTab: options?.newTab ?? newTabFromMouseEvent(event),
									})
								}
								onNavigate={(href, event?) => {
									const resolved = resolveRepositoryHref(dirPath, href);
									if (!resolved) return false;
									// Directory paths are authoritative on lix_directory, so look
									// up the exact persisted path rather than inferring kind.
									const directoryPath = persistedDirectoryPath(tree, resolved);
									if (directoryPath) {
										onOpenDir(directoryPath, {
											newTab: event ? newTabFromMouseEvent(event) : false,
										});
									} else {
										onOpenFile(resolved, {
											newTab: event ? newTabFromMouseEvent(event) : false,
										});
									}
									return true;
								}}
							/>
						</div>
					) : null}
					{entryMenu ? (
						<div
							className="fixed inset-0 z-40"
							onClick={() => setEntryMenu(null)}
							onContextMenu={(event) => {
								event.preventDefault();
								setEntryMenu(null);
							}}
						>
							<div
								role="menu"
								data-entry-context-menu=""
								className="absolute flex min-w-[164px] flex-col rounded-[10px] border border-border bg-panel p-1 shadow-[0_10px_28px_color-mix(in_srgb,var(--atelier-overlay)_14%,transparent)]"
								style={{
									left: Math.min(entryMenu.x + 2, window.innerWidth - 180),
									top: Math.min(entryMenu.y + 2, window.innerHeight - 116),
								}}
								onClick={(event) => event.stopPropagation()}
							>
								{entryMenu.id ? (
									<button
										type="button"
										role="menuitem"
										onClick={() => {
											const id = entryMenu.id;
											if (id) {
												void copyText(
													entryLink(connection, {
														kind: entryMenu.kind,
														id,
														path: entryMenu.path,
													}),
												);
											}
											setEntryMenu(null);
										}}
										className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-none font-medium text-fg hover:bg-bg-hover"
									>
										<Link2
											className="size-3.5 text-fg-muted"
											aria-hidden="true"
										/>
										Copy link
									</button>
								) : null}
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setRenameTarget(entryMenu);
										setEntryMenu(null);
									}}
									className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-none font-medium text-fg hover:bg-bg-hover"
								>
									<PencilLine
										className="size-3.5 text-fg-muted"
										aria-hidden="true"
									/>
									Rename…
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										deleteEntry(entryMenu);
										setEntryMenu(null);
									}}
									className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-none font-medium text-fg hover:bg-danger-border/10 hover:text-danger-border"
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
									Delete
								</button>
							</div>
						</div>
					) : null}
					{renameTarget ? (
						<RenameEntryDialog
							target={renameTarget}
							onClose={() => setRenameTarget(null)}
							onRename={async (nextName) => {
								if (readOnly || viewingHistory) return;
								const segments = renameTarget.path.split("/").filter(Boolean);
								segments.pop();
								const nextPath = `/${[...segments, nextName].join("/")}`;
								await renameWorkspaceEntry(
									lix,
									renameTarget.kind === "file"
										? renameTarget.id
											? { kind: "file", id: renameTarget.id }
											: { kind: "file", path: renameTarget.path }
										: { kind: "directory", path: renameTarget.path },
									nextPath,
								);
							}}
						/>
					) : null}
				</main>
				{isHome && !summary ? (
					<RepositoryControlPlaneRail
						embedded={summary}
						reviewFocus={reviewFocus}
						visibility={visibility}
						fileCount={tree.files.length}
						data={controlPlaneData}
						onOpenSettings={onOpenSettings}
						onOpenSqlExplorer={onOpenSqlExplorer}
						onOpenChangesReview={onOpenChangesReview}
						onOpenHistory={onOpenHistory}
						teamSection={teamSection}
					/>
				) : null}
			</div>
		</div>
	);
}

function useAfterInitialIdle(enabled: boolean): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (!enabled) {
			setReady(false);
			return;
		}
		let idleCallback = 0;
		let timeout = 0;
		if (typeof requestAnimationFrame !== "function") {
			timeout = window.setTimeout(() => setReady(true), 0);
			return () => window.clearTimeout(timeout);
		}
		let secondFrame = 0;
		const firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				if (typeof requestIdleCallback === "function") {
					idleCallback = requestIdleCallback(() => setReady(true), {
						timeout: 1_500,
					});
				} else {
					timeout = window.setTimeout(() => setReady(true), 0);
				}
			});
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
			if (idleCallback) cancelIdleCallback(idleCallback);
			if (timeout) window.clearTimeout(timeout);
		};
	}, [enabled]);
	return enabled && ready;
}

function RepositoryControlPlaneRail({
	reviewFocus = false,
	visibility,
	fileCount,
	data,
	onOpenSettings,
	onOpenSqlExplorer,
	onOpenChangesReview,
	onOpenHistory,
	teamSection,
	embedded = false,
}: {
	/** Review focus: sections other than Changes recede with the page. */
	readonly reviewFocus?: boolean;
	/** In the Library's narrower column: folds into the page at 820px. */
	readonly embedded?: boolean;
	readonly visibility: "private" | "public";
	readonly fileCount: number;
	readonly data: RepositoryControlPlaneData | null;
	readonly onOpenSettings?: () => void;
	readonly onOpenSqlExplorer?: () => void;
	readonly onOpenChangesReview?: () => void;
	readonly onOpenHistory?: () => void;
	readonly teamSection?: ReactNode;
}) {
	const mutedSection = ` transition-opacity${
		reviewFocus ? " opacity-[0.35] hover:opacity-100" : ""
	}`;
	return (
		<aside
			aria-label="Repository overview"
			className={
				embedded
					? "min-w-0 @max-[820px]:hidden"
					: "min-w-0 @max-[1100px]:hidden"
			}
		>
			{teamSection ? (
				<section className={`border-b border-border pb-7${mutedSection}`}>
					<RailHeading>Team &amp; agents</RailHeading>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{teamSection}
					</div>
				</section>
			) : null}
			<section
				className={`border-b border-border pb-7 ${teamSection ? "pt-7" : ""}${mutedSection}`}
			>
				<RailHeading>Repository</RailHeading>
				<button
					type="button"
					onClick={onOpenSettings}
					className="-mx-2 mt-2 flex w-[calc(100%+16px)] cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg focus-visible:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{visibility === "public" ? (
						<Globe2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					) : (
						<LockKeyhole
							className="mt-0.5 size-4 shrink-0"
							aria-hidden="true"
						/>
					)}
					<span className="min-w-0 flex-1">
						<span className="block text-[12px] font-semibold">Visibility</span>
						<span className="mt-1 block text-[11.5px] text-fg-subtle">
							{visibility === "public" ? "Public" : "Private"}
						</span>
					</span>
					<ArrowRight className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				</button>
				{onOpenSettings ? (
					<button
						type="button"
						onClick={onOpenSettings}
						className="-mx-2 mt-2 flex w-[calc(100%+16px)] cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg focus-visible:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<Settings className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span className="min-w-0 flex-1">
							<span className="block text-[12px] font-semibold">Settings</span>
							<span className="mt-1 block text-[11.5px] text-fg-subtle">
								Name, access &amp; API tokens
							</span>
						</span>
						<ArrowRight
							className="mt-0.5 size-3.5 shrink-0"
							aria-hidden="true"
						/>
					</button>
				) : null}
			</section>

			<section
				className={`border-b border-border py-7 ${embedded ? "@max-[820px]:border-t-0" : "@max-[1100px]:border-t-0"}${mutedSection}`}
			>
				<RailHeading>Changes</RailHeading>
				{data?.changeHistoryUnavailable ? (
					<p
						role="status"
						className="m-0 mt-2 text-[11.5px] leading-4 text-fg-subtle"
					>
						Complete history totals are unavailable in this view.
					</p>
				) : null}
				<ChangesSummary
					data={data}
					onOpenChangesReview={onOpenChangesReview}
					onOpenHistory={onOpenHistory}
				/>
			</section>

			<section className={`border-b border-border py-7${mutedSection}`}>
				<RailHeading>Database</RailHeading>
				<DatabaseSummary
					data={data}
					fileCount={fileCount}
					onOpenSqlExplorer={onOpenSqlExplorer}
				/>
			</section>
		</aside>
	);
}

function RepositoryNarrowStats({
	fileCount,
	data,
	onOpenSqlExplorer,
	onOpenChangesReview,
	onOpenHistory,
	teamSection,
	embedded = false,
}: {
	readonly embedded?: boolean;
	readonly fileCount: number;
	readonly data: RepositoryControlPlaneData | null;
	readonly onOpenSqlExplorer?: () => void;
	readonly onOpenChangesReview?: () => void;
	readonly onOpenHistory?: () => void;
	readonly teamSection?: ReactNode;
}) {
	return (
		<aside
			aria-label="Repository statistics"
			className={`mt-7 hidden min-w-0 grid-cols-2 gap-8 border-t border-border px-3 pt-7 @max-[640px]:grid-cols-1 ${
				embedded ? "@max-[820px]:grid" : "@max-[1100px]:grid"
			}`}
		>
			{teamSection ? (
				<section className="col-span-full min-w-0">
					<RailHeading>Team & agents</RailHeading>
					<div className="mt-2.5 flex flex-wrap gap-2">{teamSection}</div>
				</section>
			) : null}
			<section className="min-w-0">
				<RailHeading>Changes</RailHeading>
				{data?.changeHistoryUnavailable ? (
					<p
						role="status"
						className="m-0 mt-2 text-[11.5px] leading-4 text-fg-subtle"
					>
						Complete history totals are unavailable in this view.
					</p>
				) : null}
				<ChangesSummary
					data={data}
					onOpenChangesReview={onOpenChangesReview}
					onOpenHistory={onOpenHistory}
				/>
			</section>
			<section className="min-w-0">
				<RailHeading>Database</RailHeading>
				<DatabaseSummary
					data={data}
					fileCount={fileCount}
					onOpenSqlExplorer={onOpenSqlExplorer}
				/>
			</section>
		</aside>
	);
}

/** Quiet tonal chip, matching the Repository section's visibility chip. */
const RAIL_CHIP_CLASS =
	"h-7 gap-1.5 rounded-[7px] border-0 bg-bg-hover px-2.5 text-[11.5px] font-bold text-fg-muted shadow-none hover:bg-bg-hover-strong hover:text-fg-muted [&_img]:size-3 [&_svg]:size-3";

function RailHeading({ children }: { readonly children: ReactNode }) {
	return (
		<h2 className="m-0 text-[11.5px] font-bold tracking-[0.08em] text-fg-faint uppercase">
			{children}
		</h2>
	);
}

function ChangesSummary({
	data,
	onOpenChangesReview,
	onOpenHistory,
}: {
	readonly data: RepositoryControlPlaneData | null;
	readonly onOpenChangesReview?: () => void;
	readonly onOpenHistory?: () => void;
}) {
	if (!data) {
		return (
			<div className="mt-3 h-[118px] animate-pulse rounded-lg bg-bg-hover" />
		);
	}
	return (
		<ChangeBars
			data={data}
			onOpenChangesReview={onOpenChangesReview}
			onOpenHistory={onOpenHistory}
		/>
	);
}

function ChangeBars({
	data,
	onOpenChangesReview,
	onOpenHistory,
}: {
	readonly data: RepositoryControlPlaneData;
	readonly onOpenChangesReview?: () => void;
	readonly onOpenHistory?: () => void;
}) {
	const days = data.changeDays;
	if (days === null) {
		const working = describeWorkingChanges(data.workingFileCount);
		const available = data.workingFileCount !== null;
		return (
			<div className="mt-2.5">
				{available ? (
					<p className="text-[12px] text-fg-subtle">
						<strong className="text-[20px] text-fg">
							{formatCompactCount(working.count)}
						</strong>{" "}
						{working.label}
					</p>
				) : (
					<p className="text-[12px] text-fg-subtle">
						Working changes unavailable.
					</p>
				)}
				{available && working.count > 0 && onOpenChangesReview ? (
					<button
						type="button"
						onClick={onOpenChangesReview}
						className="mt-4 cursor-pointer text-[12px] font-semibold text-accent"
					>
						Review changes →
					</button>
				) : null}
			</div>
		);
	}
	const maxCount = Math.max(1, ...days.map((day) => day.count));
	const latestCheckpointDay = data.checkpointDates?.[0]?.slice(0, 10) ?? null;
	// The headline is the status bar's number: files whose working state
	// differs from the checkpoint. The bars stay a day-by-day activity graph.
	const working = describeWorkingChanges(data.workingFileCount);
	const headlineCount = working.count;
	const visibleDays = days.length > 0 ? days : [{ day: "", count: 0 }];
	const paddedDays = [
		...Array.from({ length: Math.max(0, 9 - visibleDays.length) }, () => ({
			day: "",
			count: 0,
		})),
		...visibleDays,
	];

	return (
		<div className="mt-2.5">
			<div className="flex items-baseline gap-1.5">
				<strong className="text-[20px] leading-none font-semibold tracking-[-0.03em] text-fg">
					{formatCompactCount(headlineCount)}
				</strong>
				<span className="text-[11.5px] text-fg-subtle">{working.label}</span>
			</div>
			<div className="mt-3 flex h-11 items-end gap-[3px] border-b border-border-strong">
				{paddedDays.map((entry, index) => {
					// The checkpoint's own day holds records from both sides of
					// it; it reads as "after" while anything is still unreviewed.
					const afterCheckpoint =
						!latestCheckpointDay ||
						!entry.day ||
						entry.day > latestCheckpointDay ||
						(entry.day === latestCheckpointDay && headlineCount > 0);
					const isLatest = index === paddedDays.length - 1;
					const height = entry.count
						? Math.max(7, Math.round((entry.count / maxCount) * 38))
						: 3;
					return (
						<span
							key={`${entry.day || "empty"}-${index}`}
							className={`min-w-0 flex-1 rounded-t-[2px] ${
								afterCheckpoint
									? isLatest
										? "bg-link"
										: "bg-link/50"
									: "bg-bg-hover-strong"
							}`}
							style={{ height }}
							title={
								entry.day
									? `${entry.count} ${entry.count === 1 ? "source record" : "source records"} on ${entry.day}`
									: undefined
							}
						/>
					);
				})}
			</div>
			<div className="mt-1.5 flex items-center justify-between text-[9.5px] text-fg-faint">
				<span>{formatShortDate(data.createdAt)}</span>
				{latestCheckpointDay ? <span>⚑ checkpoint</span> : null}
				<span>today</span>
			</div>
			{/* With nothing to review, the panel's action is the archive: open
			    History as a normal central tab instead of the review mode. */}
			{headlineCount > 0 && onOpenChangesReview ? (
				<button
					type="button"
					onClick={onOpenChangesReview}
					className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-accent hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					Review changes →
				</button>
			) : headlineCount === 0 && onOpenHistory ? (
				<button
					type="button"
					onClick={onOpenHistory}
					className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-accent hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					Show history →
				</button>
			) : null}
		</div>
	);
}

function DatabaseSummary({
	data,
	fileCount,
	onOpenSqlExplorer,
}: {
	readonly data: RepositoryControlPlaneData | null;
	readonly fileCount: number;
	readonly onOpenSqlExplorer?: () => void;
}) {
	if (!data) {
		return (
			<div className="mt-3 h-[132px] animate-pulse rounded-lg bg-bg-hover" />
		);
	}
	const rows = [
		{ label: "Files", count: fileCount, color: "bg-link" },
		{
			label: "Checkpoints",
			count: data.checkpointCount,
			color: "bg-border-strong",
		},
		{
			label: "Source records",
			count: data.totalChangeCount,
			color: "bg-link/50",
		},
	];

	return (
		<div className="mt-2.5">
			<div className="flex items-baseline gap-1.5">
				<strong className="text-[20px] leading-none font-semibold tracking-[-0.03em] text-fg">
					{data.tableCount === null ? "—" : formatCompactCount(data.tableCount)}
				</strong>
				<span className="text-[11.5px] text-fg-subtle">
					{data.tableCount === 1 ? "table" : "tables"}
				</span>
			</div>
			<div className="mt-3 flex h-2 overflow-hidden rounded-full bg-bg-hover">
				{rows.map((row) => (
					<span
						key={row.label}
						className={row.color}
						style={{ flexGrow: Math.max(1, row.count ?? 0) }}
					/>
				))}
			</div>
			<ul className="m-0 mt-3 space-y-1.5 p-0">
				{rows.map((row) => (
					<li
						key={row.label}
						className="flex items-center gap-2 text-[11px] text-fg-subtle"
					>
						<span className={`size-1.5 rounded-full ${row.color}`} />
						<span>{row.label}</span>
						<span className="flex-1 border-b border-dotted border-border" />
						<span className="tabular-nums">
							{row.count === null ? "—" : formatCompactCount(row.count)}
						</span>
					</li>
				))}
			</ul>
			{onOpenSqlExplorer ? (
				<button
					type="button"
					onClick={onOpenSqlExplorer}
					className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-accent hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					Open SQL Explorer →
				</button>
			) : null}
		</div>
	);
}

const compactNumber = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatCompactCount(count: number): string {
	return compactNumber.format(count);
}

function formatShortDate(value: string | null): string {
	if (!value) return "start";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "start";
	return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

/**
 * The drilled-in location of a Files surface (flow A): repository name, then
 * one crumb per folder. Every ancestor navigates the surface in place; the
 * last crumb is the folder being listed.
 */
function Breadcrumb({
	dirPath,
	onNavigate,
}: {
	readonly dirPath: string;
	readonly onNavigate: (dirPath: string, event: ReactMouseEvent) => void;
}) {
	const segments = dirPath.split("/").filter(Boolean);
	const crumbs = [
		// The repository is already named in the top bar; the explorer's own
		// root is "Home" — quiet when you're on it, a clickable way back inside.
		{ label: "Home", path: "/" },
		...segments.map((segment, index) => ({
			label: segment,
			path: `/${segments.slice(0, index + 1).join("/")}`,
		})),
	];
	return (
		<nav
			aria-label="Folder path"
			className="flex min-w-0 items-center gap-0.5 px-1 text-[13.5px] font-semibold"
		>
			{crumbs.map((crumb, index) => {
				const isCurrent = index === crumbs.length - 1;
				return (
					<span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
						{index > 0 ? (
							<span aria-hidden className="text-[12px] text-fg-faint">
								/
							</span>
						) : null}
						{isCurrent ? (
							<span
								aria-current="location"
								className={`max-w-[220px] truncate px-2 ${
									index === 0 ? "text-fg-faint" : "text-fg"
								}`}
							>
								{crumb.label}
							</span>
						) : (
							<button
								type="button"
								onClick={(event) => onNavigate(crumb.path, event)}
								className="flex h-[30px] max-w-[180px] cursor-pointer items-center truncate rounded-[7px] px-2 text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
							>
								{crumb.label}
							</button>
						)}
					</span>
				);
			})}
		</nav>
	);
}

/**
 * Connect agent (6a): the brand glyphs ride inside the button so the row
 * needs no banner. Opens the same connection dialog as Getting started.
 */
function ConnectAgentButton({
	connection,
	hasAgentConnected,
	disabled = false,
	className = "h-9 gap-2 px-3.5 text-[13px]",
}: {
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly hasAgentConnected: () => Promise<boolean>;
	readonly disabled?: boolean;
	readonly className?: string;
}) {
	const [dialogOpen, setDialogOpen] = useState(false);
	return (
		<>
			<Button
				type="button"
				variant="outline"
				className={className}
				disabled={disabled}
				onClick={() => setDialogOpen(true)}
			>
				<span className="flex items-center gap-1" aria-hidden="true">
					<img src="/landing/claude-spark.svg" alt="" className="size-3.5" />
					<img src="/landing/brand-openai.svg" alt="" className="size-3.5" />
					<img src="/landing/brand-gemini.svg" alt="" className="size-3.5" />
				</span>
				Connect agent
			</Button>
			<AgentConnectionDialog
				connection={connection}
				hasAgentConnected={hasAgentConnected}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>
		</>
	);
}

/**
 * Invite (6a): the People entry point folded into one button. Once there's a
 * team, the member avatars accumulate beside it (stack of 3, then "+N") —
 * both open the People tab.
 */
function InviteControl({
	teamApi,
	onOpenPeople,
	disabled = false,
	className = "h-9 gap-1.5 px-3.5 text-[13px]",
}: {
	teamApi: RepositoryTeamApi | null;
	onOpenPeople: () => void;
	disabled?: boolean;
	className?: string;
}) {
	const [members, setMembers] = useState<readonly TeamMember[] | null>(null);

	useEffect(() => {
		if (!teamApi) {
			setMembers(null);
			return;
		}
		let disposed = false;
		teamApi
			.listMembers()
			.then((next) => {
				if (!disposed) setMembers(next);
			})
			.catch((error: unknown) => {
				console.error("repository-home: unable to list the team", error);
			});
		return () => {
			disposed = true;
		};
	}, [teamApi]);

	const team = members ?? [];
	const overflow = Math.max(0, team.length - 3);

	return (
		<div className="flex items-center gap-2">
			{team.length > 1 ? (
				<button
					type="button"
					disabled={disabled}
					onClick={onOpenPeople}
					aria-label={`${team.length} people — open People`}
					className="flex cursor-pointer items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span className="flex -space-x-1.5">
						{team.slice(0, 3).map((member) => (
							<MemberAvatar
								key={member.accountId}
								member={member}
								className="size-6 text-[11px] ring-2 ring-panel"
							/>
						))}
						{overflow > 0 ? (
							<span className="flex size-6 items-center justify-center rounded-full bg-bg-hover text-[10px] font-semibold text-fg-muted ring-2 ring-panel">
								+{overflow}
							</span>
						) : null}
					</span>
				</button>
			) : null}
			<Button
				type="button"
				variant="outline"
				className={className}
				disabled={disabled}
				onClick={onOpenPeople}
			>
				<UserRoundPlus className="size-3.5" aria-hidden="true" />
				Invite
			</Button>
		</div>
	);
}

/**
 * Drag-and-drop file import for the directory view; the caller renders
 * {@link DropImportOverlay} and surfaces errors.
 */
function useImportDrop({
	lix,
	dirPath,
	readOnly,
	onError,
}: {
	readonly lix: Lix;
	readonly dirPath: string;
	readonly readOnly: boolean;
	readonly onError: (message: string | null) => void;
}) {
	const [isDropTarget, setIsDropTarget] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const importingRef = useRef(false);
	const dragDepthRef = useRef(0);
	const inList = (event: ReactDragEvent) =>
		(event.target as HTMLElement).closest('[data-testid="home-entry-list"]');
	const clearTarget = () => {
		dragDepthRef.current = 0;
		setIsDropTarget(false);
	};
	const handleDrop = (event: ReactDragEvent) => {
		clearTarget();
		if (inList(event)) return;
		event.preventDefault();
		if (
			readOnly ||
			importingRef.current ||
			!event.dataTransfer.types.includes("Files")
		)
			return;
		const entries = collectDroppedWorkspaceEntries(event.dataTransfer);
		importingRef.current = true;
		setIsImporting(true);
		onError(null);
		void entries
			.then((items) => importWorkspaceEntries(lix, dirPath, items))
			.then(({ failed }) => {
				if (failed.length)
					onError(
						`Could not import: ${failed.join(", ")}. Existing items were kept.`,
					);
			})
			.catch((error: unknown) => {
				console.error("repository-home: import failed", error);
				onError("Unable to import the dropped files and folders.");
			})
			.finally(() => {
				importingRef.current = false;
				setIsImporting(false);
			});
	};
	return {
		isDropTarget,
		isImporting,
		dragHandlers: {
			onDragEnter: (event: ReactDragEvent) => {
				if (inList(event)) {
					clearTarget();
					return;
				}
				event.preventDefault();
				if (
					readOnly ||
					importingRef.current ||
					!event.dataTransfer.types.includes("Files")
				)
					return;
				dragDepthRef.current += 1;
				setIsDropTarget(true);
			},
			onDragOver: (event: ReactDragEvent) => {
				if (inList(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect =
					readOnly || importingRef.current ? "none" : "copy";
			},
			onDragLeave: () => {
				dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
				if (!dragDepthRef.current) setIsDropTarget(false);
			},
			onDrop: handleDrop,
		},
	};
}

function DropImportOverlay() {
	return (
		<div className="pointer-events-none absolute inset-2 z-10 grid place-content-center rounded-xl border-2 border-dashed border-accent bg-panel/85 text-sm font-semibold text-fg-muted">
			Drop files and folders to import
		</div>
	);
}

/** Home's status chips: quiet, rounded, one line of them. */
const HOME_CHIP_CLASS =
	"h-7 gap-1.5 rounded-full border border-border bg-panel px-2.5 text-[12px] font-medium text-fg-muted shadow-none hover:bg-bg-hover hover:text-fg [&_img]:size-3 [&_svg]:size-3.5";

/**
 * Home's one line about the repository: whether an agent is connected, what
 * has changed since the last checkpoint, the database, who can see it, and
 * Invite. Each chip is the way into that part of the product.
 */
function HomeStatusLine({
	data,
	visibility,
	connection,
	hasAgentConnected,
	readOnly,
	invite,
	onOpenChangesReview,
	onOpenHistory,
	onOpenSqlExplorer,
	onOpenSettings,
}: {
	readonly data: RepositoryControlPlaneData | null;
	readonly visibility: "private" | "public";
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly hasAgentConnected: (() => Promise<boolean>) | null;
	readonly readOnly: boolean;
	readonly invite: ReactNode;
	readonly onOpenChangesReview?: () => void;
	readonly onOpenHistory?: () => void;
	readonly onOpenSqlExplorer?: () => void;
	readonly onOpenSettings?: () => void;
}) {
	const [agentConnected, setAgentConnected] = useState<boolean | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	useEffect(() => {
		if (!hasAgentConnected) return;
		let disposed = false;
		hasAgentConnected()
			.then((connected) => {
				if (!disposed) setAgentConnected(connected);
			})
			.catch(() => {
				if (!disposed) setAgentConnected(false);
			});
		return () => {
			disposed = true;
		};
	}, [hasAgentConnected, dialogOpen]);
	const changed = data?.workingFileCount ?? null;
	return (
		<div
			className="flex flex-wrap items-center gap-2 pb-8"
			data-testid="home-status-line"
		>
			{hasAgentConnected && !readOnly ? (
				<>
					<Button
						type="button"
						variant="outline"
						className={HOME_CHIP_CLASS}
						onClick={() => setDialogOpen(true)}
					>
						{agentConnected ? (
							<>
								<span
									aria-hidden="true"
									className="size-1.5 rounded-full bg-success"
								/>
								Agent connected
							</>
						) : (
							<>
								<span className="flex items-center gap-1" aria-hidden="true">
									<img src="/landing/claude-spark.svg" alt="" />
									<img src="/landing/brand-openai.svg" alt="" />
									<img src="/landing/brand-gemini.svg" alt="" />
								</span>
								Connect an agent
							</>
						)}
					</Button>
					<AgentConnectionDialog
						connection={connection}
						hasAgentConnected={hasAgentConnected}
						open={dialogOpen}
						onOpenChange={setDialogOpen}
					/>
				</>
			) : null}
			{changed !== null && changed > 0 && onOpenChangesReview ? (
				<Button
					type="button"
					variant="outline"
					className={HOME_CHIP_CLASS}
					onClick={onOpenChangesReview}
				>
					<GitCompareArrows aria-hidden="true" />
					{changed} {changed === 1 ? "change" : "changes"}
					<span className="text-link">Review</span>
				</Button>
			) : changed === 0 && onOpenHistory ? (
				<Button
					type="button"
					variant="outline"
					className={HOME_CHIP_CLASS}
					onClick={onOpenHistory}
				>
					<Check aria-hidden="true" />
					All checkpointed
				</Button>
			) : null}
			{data?.tableCount != null && onOpenSqlExplorer ? (
				<Button
					type="button"
					variant="outline"
					className={HOME_CHIP_CLASS}
					onClick={onOpenSqlExplorer}
				>
					<Database aria-hidden="true" />
					Database
					<span className="text-fg-subtle">
						{data.tableCount} {data.tableCount === 1 ? "table" : "tables"}
					</span>
				</Button>
			) : null}
			{onOpenSettings ? (
				<Button
					type="button"
					variant="outline"
					className={HOME_CHIP_CLASS}
					onClick={onOpenSettings}
					title="Visibility and settings"
				>
					{visibility === "public" ? (
						<Globe2 aria-hidden="true" />
					) : (
						<LockKeyhole aria-hidden="true" />
					)}
					{visibility === "public" ? "Public" : "Private"}
				</Button>
			) : null}
			{invite}
		</div>
	);
}

/** Home without a README: the one thing that would make it useful. */
function AddReadmeCard({ onCreate }: { readonly onCreate: () => void }) {
	return (
		<div
			data-testid="home-add-readme"
			className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border px-6 py-8"
		>
			<p className="m-0 text-[14px] font-semibold text-fg">Add a README</p>
			<p className="m-0 max-w-md text-[13px] leading-relaxed text-fg-subtle">
				Say what this repository is for and how it is organised. Your team, and
				the agents you connect, read it first.
			</p>
			<Button variant="outline" onClick={onCreate}>
				Write README
			</Button>
		</div>
	);
}

function ReadmePreview({
	lix,
	sourceFilePath,
	fileId,
	diff,
	fileName,
	documentLinks,
	onOpen,
	onOpenLinkedFile,
	onNavigate,
	section = false,
}: {
	/** Home: a "README" heading like the page's other sections, Edit beside it. */
	readonly section?: boolean;
	readonly lix: Lix;
	readonly sourceFilePath: string;
	readonly fileId: string | null;
	/** Present while a review marks the README; renders the diff itself. */
	readonly diff:
		| AtelierFileProps
		| { fileId: string; unavailable: true }
		| null;
	readonly fileName: string;
	/** Lets the preview recognise this repository's own file URLs. */
	readonly documentLinks?: AtelierDocumentLinks;
	/** Opens the README tab; `newTab` overrides the modifier-key default. */
	readonly onOpen: (
		event: ReactMouseEvent,
		options?: { newTab: boolean },
	) => void;
	/** Opens a file the README links to, in a tab of this workspace. */
	readonly onOpenLinkedFile: (path: string) => void;
	/** Returns true when the link was handled inside the tab model. */
	readonly onNavigate: (href: string, event?: ReactMouseEvent) => boolean;
}) {
	if (!fileId) return null;
	// The preview is the document set on the page, not a card. One hairline
	// closes the file list and carries a caption (icon, file name, Edit) in
	// the list's own tertiary type, so it reads as the list's footer and the
	// document's byline at once. The rule starts where a row's hover ground
	// starts, and everything under it — the caption and the document — keeps
	// the rows' own inset, so the text sits on the rows' icon column and ends
	// where their right edge does.
	return (
		<section
			aria-label={`${fileName} preview`}
			data-testid="home-readme-preview"
			className={section ? "" : "mt-7 border-t border-border"}
		>
			{section ? (
				<div className="flex items-center gap-1 pb-3">
					<h2 className="m-0 text-[13px] font-semibold text-fg-muted">
						Readme
					</h2>
					<button
						type="button"
						data-testid="home-readme-edit"
						aria-label={`Edit ${fileName}`}
						title={`Edit ${fileName}`}
						// On Home, the README opens beside the Library tab.
						onClick={(event) => onOpen(event, { newTab: true })}
						className="grid size-6 place-items-center rounded-md text-fg-subtle hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
					>
						<PencilLine aria-hidden="true" className="size-3.5" />
					</button>
				</div>
			) : (
				<div className="flex h-11 items-center gap-3 px-3 text-xs font-medium text-fg-subtle">
					<img
						src={fileIconUrl(fileName)}
						alt=""
						draggable={false}
						className="size-[19px] shrink-0"
					/>
					<span className="min-w-0 flex-1 truncate" title={fileName}>
						{fileName}
					</span>
					<button
						type="button"
						data-testid="home-readme-edit"
						aria-label={`Edit ${fileName}`}
						title={`Edit ${fileName}`}
						onClick={(event) => onOpen(event)}
						className="-mr-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg-subtle hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
					>
						<PencilLine aria-hidden="true" className="size-3.5" />
						Edit
					</button>
				</div>
			)}
			{/* Relative README links navigate the tab in place (rule 3) instead
			    of escaping to a full page load. */}
			{/* Click delegation only augments the anchors inside, which stay
			    keyboard-accessible on their own. */}
			{/* The standalone file view strips the document's page padding, so
			    the section owns its inner margins: the same inset the rows and
			    the caption carry, with a heading's beat below. */}
			<div
				data-testid="home-readme"
				onClick={(event) => {
					const anchor = (event.target as HTMLElement).closest("a");
					if (!anchor) return;
					const href = anchor.getAttribute("href") ?? "";
					if (onNavigate(href, event)) {
						event.preventDefault();
					}
				}}
				className={section ? "pb-9" : "px-3 pt-2 pb-9"}
			>
				{/* Quick Look: the extension that owns the file type renders
				    the preview — and during a review, the diff — so every
				    state shares the editor's own presentation. */}
				{diff && "unavailable" in diff ? (
					<div role="alert" className="text-[13px]">
						The working diff changed while it was being reviewed. Reopen the
						review.
					</div>
				) : (
					<AtelierFile
						readOnly
						{...(documentLinks ? { documentLinks } : {})}
						onOpenFile={onOpenLinkedFile}
						{...(diff ?? { lix, fileId, filePath: sourceFilePath })}
					/>
				)}
			</div>
		</section>
	);
}

/**
 * What the empty repository offers to start with. The New menu names the same
 * three types; here they are buttons, so they carry the bare type name.
 */
const NEW_FILE_KINDS = [
	{ extension: "md", label: "Markdown", testId: "home-create-file-md" },
	{ extension: "csv", label: "CSV", testId: "home-create-file-csv" },
	{
		extension: "excalidraw",
		label: "Drawing",
		testId: "home-create-file-excalidraw",
	},
] as const;

/**
 * Home's own New button. Atelier's New menu renders it as its trigger, so the
 * menu below it is the workspace's menu and the button above it is home's.
 */
const NewButton = forwardRef<
	HTMLButtonElement,
	ComponentPropsWithoutRef<typeof Button>
>(function NewButton({ disabled = false, ...props }, ref) {
	return (
		<Button
			ref={ref}
			disabled={disabled}
			type="button"
			variant="featured"
			className="h-9 gap-1.5 px-3.5 text-[13.5px] font-bold"
			data-testid="home-new-button"
			{...props}
		>
			<Plus className="size-3.5" aria-hidden="true" />
			New
			<ChevronDown className="size-3 opacity-80" aria-hidden="true" />
		</Button>
	);
});

function RenameEntryDialog({
	target,
	onClose,
	onRename,
}: {
	readonly target: { kind: "file" | "directory"; name: string };
	readonly onClose: () => void;
	readonly onRename: (nextName: string) => Promise<void>;
}) {
	const [name, setName] = useState(target.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		// Preselect the base name so typing replaces it, keeping a file's
		// extension in place — the File Explorer's rename behaves the same.
		const dotIndex = target.kind === "file" ? target.name.lastIndexOf(".") : -1;
		input.setSelectionRange(0, dotIndex > 0 ? dotIndex : target.name.length);
	}, [target]);
	const submit = () => {
		const trimmed = name.trim();
		if (!trimmed || trimmed === target.name) {
			onClose();
			return;
		}
		if (trimmed.includes("/")) {
			setError("Names cannot contain slashes.");
			return;
		}
		setBusy(true);
		setError(null);
		onRename(trimmed)
			.then(onClose)
			.catch((renameError: unknown) => {
				console.error("repository-home: rename failed", renameError);
				setBusy(false);
				setError(
					renameError instanceof WorkspacePathTakenError
						? `Something here is already named “${trimmed}”.`
						: "Unable to rename. Try again.",
				);
			});
	};
	return (
		<div
			className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/30"
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-label={`Rename ${target.name}`}
				className="w-[340px] rounded-xl border border-border bg-panel p-4 shadow-[0_18px_44px_color-mix(in_srgb,var(--atelier-overlay)_24%,transparent)]"
				onClick={(event) => event.stopPropagation()}
			>
				<h2 className="m-0 text-[13.5px] font-bold text-fg">
					Rename {target.kind === "file" ? "file" : "folder"}
				</h2>
				<input
					ref={inputRef}
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						setError(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") submit();
						if (event.key === "Escape") onClose();
					}}
					disabled={busy}
					className="mt-3 h-9 w-full rounded-lg border border-border bg-bg px-2.5 text-[13.5px] text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
				/>
				{error ? (
					<p
						role="alert"
						className="mt-2 mb-0 text-[12.5px] text-danger-border"
					>
						{error}
					</p>
				) : null}
				<div className="mt-3.5 flex justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						className="h-8 px-3 text-[13px] font-bold"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="featured"
						className="h-8 px-3.5 text-[13px] font-bold"
						onClick={submit}
						disabled={busy}
					>
						Rename
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * Illustration for the getting-started state: a sketched document card with
 * agent icons feeding into it along dashed paths (12f in the comp).
 */
function GettingStartedIllustration() {
	return (
		<div aria-hidden="true" className="relative mb-6 h-[118px] w-[300px]">
			<div className="absolute top-0 left-1/2 flex w-[230px] -translate-x-1/2 rotate-[-1.5deg] flex-col gap-[7px] rounded-[10px] border border-border bg-panel px-3.5 py-3 shadow-[0_10px_26px_color-mix(in_srgb,var(--atelier-overlay)_9%,transparent)]">
				<div className="flex items-center gap-[7px]">
					<img src={fileIconUrl("file.md")} alt="" className="size-[13px]" />
					<span className="h-[7px] w-24 rounded bg-border-strong" />
					<span className="flex-1" />
					<span className="inline-flex size-[15px] items-center justify-center rounded-[4.5px] bg-accent-subtle ring-1 ring-border ring-inset">
						<img
							src="/landing/claude-spark.svg"
							alt=""
							className="size-[9px]"
						/>
					</span>
				</div>
				<div className="flex items-center gap-[7px]">
					<img src={fileIconUrl("file.csv")} alt="" className="size-[13px]" />
					<span className="h-[7px] w-[68px] rounded bg-border" />
					<span className="flex-1" />
					<img src="/landing/codex-icon.svg" alt="" className="size-[15px]" />
				</div>
				<div className="flex items-center gap-[7px]">
					<img
						src={fileIconUrl("file.excalidraw")}
						alt=""
						className="size-[13px]"
					/>
					<span className="h-[7px] w-[118px] rounded bg-border" />
				</div>
			</div>
			<span className="absolute bottom-3.5 left-2 inline-flex size-[34px] rotate-[-6deg] items-center justify-center rounded-[10px] bg-accent-subtle ring-1 ring-border ring-inset shadow-[0_6px_14px_color-mix(in_srgb,var(--atelier-overlay)_8%,transparent)]">
				<img src="/landing/claude-spark.svg" alt="" className="size-[19px]" />
			</span>
			<img
				src="/landing/codex-icon.svg"
				alt=""
				className="absolute right-2.5 bottom-3 size-[34px] rotate-[5deg] drop-shadow-[0_6px_14px_color-mix(in_srgb,var(--atelier-overlay)_12%,transparent)]"
			/>
			<svg
				width="46"
				height="30"
				viewBox="0 0 46 30"
				fill="none"
				stroke="var(--atelier-border-strong)"
				strokeWidth="1.8"
				strokeLinecap="round"
				className="absolute bottom-[26px] left-11"
			>
				<path d="M4 24 C 14 18, 26 10, 40 5" strokeDasharray="1 6" />
			</svg>
			<svg
				width="46"
				height="30"
				viewBox="0 0 46 30"
				fill="none"
				stroke="var(--atelier-border-strong)"
				strokeWidth="1.8"
				strokeLinecap="round"
				className="absolute right-[46px] bottom-6"
			>
				<path d="M42 24 C 32 18, 20 10, 6 5" strokeDasharray="1 6" />
			</svg>
		</div>
	);
}

/**
 * The empty-repository pitch (12f in the comp), rendered inline where the
 * home listing would be: connect an agent, start a document yourself, or
 * drop files anywhere to import.
 */
export function GettingStarted({
	connection,
	hasAgentConnected,
	onCreateFile,
}: {
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly hasAgentConnected: () => Promise<boolean>;
	readonly onCreateFile: (extension: "md" | "csv" | "excalidraw") => void;
}) {
	const [connectDialogOpen, setConnectDialogOpen] = useState(false);
	return (
		<>
			<div
				className="flex flex-col items-center text-center"
				data-testid="home-getting-started"
			>
				<div className="flex w-[min(560px,100%)] flex-col items-center">
					<GettingStartedIllustration />
					<h1 className="m-0 text-2xl font-bold tracking-[-0.02em]">
						Welcome to your Lix repository
					</h1>
					<p className="mt-3 mb-0 max-w-[470px] text-[14.5px] leading-[1.6] text-fg-muted">
						A shared folder for you and your AI agents. Connect Claude, Codex,
						or Cursor — everything it writes lands here, with full change
						history.
					</p>
					<button
						type="button"
						onClick={() => setConnectDialogOpen(true)}
						className="mt-5.5 mb-10.5 inline-flex items-center gap-2 rounded-[10px] bg-[linear-gradient(180deg,var(--atelier-link)_0%,var(--atelier-link)_100%)] px-4.5 py-2.75 text-sm font-bold text-accent-on shadow-accent hover:brightness-105"
					>
						<Link2 className="size-3.5" aria-hidden="true" />
						Connect an agent
					</button>
					<div className="mb-3.5 text-[11.5px] font-bold tracking-[0.06em] text-fg-faint uppercase">
						or start yourself
					</div>
					<div className="flex justify-center gap-2.5">
						{NEW_FILE_KINDS.map((kind) => (
							<button
								key={kind.extension}
								type="button"
								data-testid={kind.testId}
								onClick={() => onCreateFile(kind.extension)}
								className="inline-flex items-center gap-2 rounded-[9px] bg-bg-hover px-3.5 py-2.5 text-[13px] font-semibold text-fg-muted hover:bg-bg-active"
							>
								<img
									src={fileIconUrl(`file.${kind.extension}`)}
									alt=""
									className="size-4"
								/>
								{kind.label}
							</button>
						))}
					</div>
					<div className="mt-4.5 text-xs text-fg-faint">
						…or drop files anywhere in this window to import
					</div>
				</div>
			</div>
			<AgentConnectionDialog
				connection={connection}
				hasAgentConnected={hasAgentConnected}
				open={connectDialogOpen}
				onOpenChange={setConnectDialogOpen}
			/>
		</>
	);
}

function AgentConnectionDialog({
	connection,
	hasAgentConnected,
	open,
	onOpenChange,
}: {
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly hasAgentConnected: () => Promise<boolean>;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	const { details, copyPrompt, copyState } =
		useAgentConnectionPrompt(connection);
	const connectionStatus = useMcpConnectionStatus(open, hasAgentConnected);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100vh-2rem)] w-[min(520px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto rounded-2xl border-border bg-panel p-0 text-fg shadow-[0_30px_90px_color-mix(in_srgb,var(--atelier-overlay)_30%,transparent)] sm:max-w-none">
				<DialogHeader className="gap-1.5 px-8 pt-8 pr-14 text-left">
					<DialogTitle className="text-lg leading-tight font-bold tracking-[-0.01em]">
						Connect an agent
					</DialogTitle>
					<DialogDescription className="text-[13.5px] leading-[1.55] text-fg-muted">
						Copy the prompt into Claude, ChatGPT, or Gemini. It handles the
						rest.
					</DialogDescription>
				</DialogHeader>

				<div className="px-8">
					<ConnectionStep number={1} label="Copy the prompt" active />
					<button
						type="button"
						onClick={() => void copyPrompt()}
						className="inline-flex items-center gap-2 rounded-[10px] bg-[linear-gradient(180deg,var(--atelier-link)_0%,var(--atelier-link)_100%)] px-4.5 py-2.75 text-sm font-bold text-accent-on shadow-accent hover:brightness-105"
					>
						{/* Icon crossfade per Atelier's copy-markdown button: the Copy
						    glyph gives way to a green check, then swaps back so the
						    prompt can be re-copied. */}
						<span className="relative inline-flex size-[18px] items-center justify-center">
							<Copy
								className={`size-3.5 transition-all duration-150 ${
									copyState === "copied"
										? "scale-75 opacity-0"
										: "scale-100 opacity-100"
								}`}
								aria-hidden="true"
							/>
							<span
								className={`absolute inset-0 grid place-items-center rounded-full bg-panel transition-all duration-150 ${
									copyState === "copied"
										? "scale-100 opacity-100"
										: "scale-75 opacity-0"
								}`}
							>
								<Check
									className="size-3 text-success"
									strokeWidth={3}
									aria-hidden="true"
								/>
							</span>
						</span>
						{copyState === "copied"
							? "Copied prompt"
							: copyState === "copying"
								? "Copying…"
								: copyState === "error"
									? "Copy failed"
									: "Copy prompt"}
					</button>

					{/* The prompt itself, not only a button that claims to have
					    copied it: a reader can see what they are about to paste,
					    select part of it, or read it to someone. */}
					<pre className="mt-3 max-h-56 overflow-auto rounded-[10px] border border-border-subtle bg-bg-subtle px-3.5 py-3 text-[12.5px] leading-[1.55] whitespace-pre-wrap text-fg-muted select-text">
						{details.prompt}
					</pre>

					<ConnectionStep number={2} label="Paste it into your AI chat" />
					{/* A looping 7s mock of the copy-paste-send moment (12g), staged
					    inside a fake browser window (traffic-light navbar, page area)
					    so the chat reads as the user's own browser tab — not a real
					    input. The cursor presses Copy prompt, carries it down, pastes,
					    and sends. Reduced motion shows the pasted end state statically. */}
					<div className="rounded-[14px] shadow-[0_10px_28px_color-mix(in_srgb,var(--atelier-overlay)_18%,transparent)]">
						<div
							aria-hidden="true"
							className="flex items-center gap-2.5 rounded-t-[14px] border-b border-overlay-hairline bg-overlay-raised px-3 py-2"
						>
							<span className="flex items-center gap-1.5">
								<span
									className="size-2.5 rounded-full bg-[#FF5F57]" /* token-literal: macOS window control */
								/>
								<span
									className="size-2.5 rounded-full bg-[#FEBC2E]" /* token-literal: macOS window control */
								/>
								<span
									className="size-2.5 rounded-full bg-[#28C840]" /* token-literal: macOS window control */
								/>
							</span>
							<span className="flex items-center gap-1 text-overlay-fg-subtle">
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.4"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M15 18l-6-6 6-6" />
								</svg>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.4"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="opacity-40"
								>
									<path d="M9 6l6 6-6 6" />
								</svg>
							</span>
							<span className="flex flex-1 items-center gap-1.5 rounded-[7px] bg-overlay px-2.5 py-1.5 text-[11px] font-medium text-overlay-fg-subtle">
								<svg
									width="9"
									height="10"
									viewBox="0 0 10 11"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.4"
									strokeLinecap="round"
								>
									<rect x="1" y="4.5" width="8" height="5.5" rx="1.5" />
									<path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" />
								</svg>
								chatgpt.com
							</span>
							<span className="flex items-center gap-2">
								<img
									src="/landing/claude-spark.svg"
									alt="Claude"
									className="size-3.5"
								/>
								<img
									src="/landing/brand-openai.svg"
									alt="ChatGPT"
									className="size-3.5 object-contain invert"
								/>
								<img
									src="/landing/brand-gemini.svg"
									alt="Gemini"
									className="size-3.5 object-contain"
								/>
							</span>
						</div>
						<div className="rounded-b-[14px] bg-overlay p-4">
							<div className="relative rounded-[14px] bg-overlay-raised px-4 pt-3.5 pb-3 text-left ring-1 ring-overlay-hairline ring-inset">
								<div className="relative h-[21px] text-[13.5px]">
									<span
										aria-hidden="true"
										className="absolute top-0 left-0 text-overlay-fg-subtle animate-connect-placeholder motion-reduce:hidden"
									>
										<span className="mr-[3px] inline-block h-[15px] w-[1.5px] bg-overlay-fg align-text-bottom animate-connect-caret" />
										Do anything
									</span>
									<span className="absolute top-0 left-0 inline-flex rounded-[5px] bg-link/15 px-[7px] py-0.5 font-mono text-xs text-overlay-accent opacity-0 animate-connect-chip motion-reduce:opacity-100 motion-reduce:animate-none">
										[prompt]
									</span>
								</div>
								<div className="mt-4 flex items-center gap-3">
									<span className="text-base leading-none text-overlay-fg-subtle">
										＋
									</span>
									<span className="flex-1" />
									<span className="relative inline-flex size-[26px] items-center justify-center rounded-full bg-overlay-hover animate-connect-send motion-reduce:animate-none">
										<ArrowUp
											className="size-3.5 text-overlay-fg animate-connect-send-arrow motion-reduce:animate-none"
											aria-hidden="true"
										/>
										<span className="absolute inset-0 flex items-center justify-center opacity-0 animate-connect-spinner-show motion-reduce:hidden">
											<span className="box-border size-[13px] rounded-full border-2 border-overlay-fg/25 border-t-overlay-fg animate-connect-spin" />
										</span>
									</span>
								</div>
								<div
									aria-hidden="true"
									className="absolute top-4 right-4 h-0 w-0 opacity-0 animate-connect-cursor motion-reduce:hidden"
								>
									<svg
										width="17"
										height="20"
										viewBox="0 0 17 20"
										className="drop-shadow-[0_2px_4px_color-mix(in_srgb,var(--atelier-overlay)_50%,transparent)]"
									>
										<path
											d="M1 1l0 14.5 3.9-3.4 2.5 6 2.7-1.1-2.5-5.9 5.4-.4z"
											fill="var(--atelier-overlay-fg)"
											stroke="var(--atelier-overlay)"
											strokeWidth="1.3"
											strokeLinejoin="round"
										/>
									</svg>
									<span className="absolute top-4 left-4 inline-flex gap-1 opacity-0 animate-connect-keys">
										<span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md bg-bg px-[5px] text-[11px] font-bold text-fg shadow-[0_2px_0_var(--atelier-fg-faint),0_4px_10px_var(--atelier-scrim)]">
											⌘
										</span>
										<span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md bg-bg text-[11px] font-bold text-fg shadow-[0_2px_0_var(--atelier-fg-faint),0_4px_10px_var(--atelier-scrim)]">
											V
										</span>
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>

				<div
					className="mt-7 flex items-center justify-end border-t border-border-subtle px-8 py-5"
					aria-live="polite"
				>
					<div
						className="inline-flex items-center gap-2.5 rounded-[10px] bg-bg-hover px-4.5 py-2.75 text-[13.5px] font-semibold text-fg-muted"
						data-testid="agent-connection-status"
					>
						{connectionStatus === "connected" ? (
							<>
								<span className="inline-flex size-4 items-center justify-center rounded-full bg-success text-accent-on">
									<Check className="size-2.5" aria-hidden="true" />
								</span>
								Agent connected
							</>
						) : (
							<>
								<span className="size-2 rounded-full bg-accent animate-connect-dot-pulse motion-reduce:animate-none" />
								Waiting for agent…
							</>
						)}
					</div>
				</div>
				<span className="sr-only">
					The copied prompt connects {details.serverName} at {details.mcpUrl}.
				</span>
			</DialogContent>
		</Dialog>
	);
}

function useMcpConnectionStatus(
	open: boolean,
	hasAgentConnected: () => Promise<boolean>,
): "waiting" | "connected" {
	const [status, setStatus] = useState<"waiting" | "connected">("waiting");

	useEffect(() => {
		if (!open) return;
		let disposed = false;
		let timeout: number | undefined;
		setStatus("waiting");

		const poll = async (): Promise<void> => {
			let connected = false;
			try {
				connected = await hasAgentConnected();
			} catch (error) {
				console.warn(
					"repository-home: unable to check agent connection",
					error,
				);
			}
			if (disposed) return;
			if (connected) {
				setStatus("connected");
				return;
			}
			timeout = window.setTimeout(() => void poll(), 1_000);
		};

		void poll();
		return () => {
			disposed = true;
			if (timeout !== undefined) window.clearTimeout(timeout);
		};
	}, [hasAgentConnected, open]);

	return status;
}

function ConnectionStep({
	number,
	label,
	active = false,
}: {
	readonly number: number;
	readonly label: string;
	readonly active?: boolean;
}) {
	return (
		<div className="mt-[30px] mb-3 flex items-center gap-2">
			<span
				className={
					active
						? "inline-flex size-[18px] items-center justify-center rounded-full bg-fg text-[10.5px] font-bold text-panel"
						: "inline-flex size-[18px] items-center justify-center rounded-full bg-bg-hover text-[10.5px] font-bold text-fg-muted"
				}
			>
				{number}
			</span>
			<span className="text-xs font-bold tracking-[0.05em] text-fg-muted uppercase">
				{label}
			</span>
		</div>
	);
}

function useAgentConnectionPrompt(
	connection: Omit<LixConnectionPromptInput, "origin">,
) {
	const { lixId, lixName, lixSlug, namespace } = connection;
	const details = useMemo(
		() =>
			createLixConnectionDetails({
				lixId,
				lixName,
				lixSlug,
				namespace,
				origin: window.location.origin,
			}),
		[lixId, lixName, lixSlug, namespace],
	);
	const [copyState, setCopyState] = useState<
		"idle" | "copying" | "copied" | "error"
	>("idle");
	const copyPrompt = async () => {
		setCopyState("copying");
		try {
			await copyText(details.prompt);
			setCopyState("copied");
			// Long enough to register the success, then back to Copy prompt so
			// the user can re-copy.
			window.setTimeout(() => setCopyState("idle"), 2_500);
		} catch (error) {
			console.error("repository-home: unable to copy agent prompt", error);
			setCopyState("error");
		}
	};
	return { details, copyPrompt, copyState };
}

/**
 * The address of a file or folder in this repository, on the page's own
 * origin and branch, so a pasted link lands exactly where the reader is.
 * It is the entity route the app itself navigates to, id included.
 */
function entryLink(
	connection: Omit<LixConnectionPromptInput, "origin">,
	entry: { kind: "file" | "directory"; id: string; path: string },
): string {
	const url = new URL(window.location.href);
	url.pathname = entityRoutePath(
		connection.namespace,
		connection.lixSlug,
		entry.kind,
		entry.id,
		entry.path,
	);
	url.hash = "";
	return url.toString();
}

async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = window.setTimeout(
					() => reject(new Error("Clipboard write timed out")),
					750,
				);
				void navigator.clipboard.writeText(text).then(
					() => {
						window.clearTimeout(timeout);
						resolve();
					},
					(error: unknown) => {
						window.clearTimeout(timeout);
						reject(error instanceof Error ? error : new Error(String(error)));
					},
				);
			});
			return;
		} catch {
			// Fall back for embedded browsers that expose Clipboard but do not
			// settle its permission request.
		}
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("Clipboard copy is unavailable");
}
