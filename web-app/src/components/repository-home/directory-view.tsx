import type { Lix } from "@lix-js/sdk";
import {
	Atelier,
	deleteWorkspaceEntry,
	renameWorkspaceEntry,
	WorkspacePathTakenError,
} from "@opral/atelier";
import type { AtelierDiffSession, AtelierFileViewProps } from "@opral/atelier";
import { fileIconUrl } from "@opral/atelier/file-icons";
import {
	ArrowUp,
	Check,
	ChevronDown,
	Copy,
	Globe2,
	Link2,
	LockKeyhole,
	PencilLine,
	Plus,
	Trash2,
	UserRoundPlus,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent as ReactDragEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import { Button } from "~/components/ui/button";
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
	createRepositoryFolder,
	formatUpdatedAt,
	importDroppedFiles,
	listDirectory,
	persistedDirectoryPath,
	resolveRepositoryHref,
	useFileMarkdown,
	useRepositoryControlPlaneData,
	listDirectoryFromFiles,
	useFilesAtCommit,
	useRepositoryTree,
	type RepositoryControlPlaneData,
} from "./lix-data";
import {
	MemberAvatar,
	type TeamMember,
	type RepositoryTeamApi,
} from "./people-view";

type DirectoryViewProps = {
	readonly lix: Lix;
	/** The open diff session; its files get change indicators in the listing. */
	readonly diffSession?: AtelierDiffSession | null;
	/** Opens a changed file through the diff session (review-aware). */
	readonly onOpenDiffFile?: (path: string) => void;
	/** Normalized trailing-slash directory path; "/" is the repository home. */
	readonly dirPath: string;
	/** The pinned home shows the connect row. */
	readonly isHome: boolean;
	/** Mirrors the bundled Atelier Files extension's authoritative preference. */
	readonly showHiddenFiles?: boolean;
	readonly readOnly: boolean;
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
export function DirectoryView({
	lix,
	diffSession = null,
	onOpenDiffFile,
	dirPath,
	isHome,
	showHiddenFiles = false,
	readOnly,
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
	const { tree, error: treeError } = useRepositoryTree(lix, isActive);
	const detailsEnabled = useAfterInitialIdle(
		isActive && isHome && tree !== null,
	);
	const controlPlaneData = useRepositoryControlPlaneData(lix, detailsEnabled);
	// Time travel: a historical session renders the listing as of its target
	// commit. The working review keeps the live listing — its whole point is
	// the latest state against the last checkpoint.
	const historicalCommitId =
		diffSession && "commitId" in diffSession.target
			? diffSession.target.commitId
			: null;
	const historicalFiles = useFilesAtCommit(lix, historicalCommitId);
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
	// The open diff session marks its files in the listing, mirroring the
	// sidebar's review indicators; folders inherit a dot from any changed
	// descendant so drilling in stays guided.
	const changedFileKinds = useMemo(() => {
		return new Map(
			(diffSession?.files ?? []).map((file) => [
				file.path,
				file.movedFromPath && file.changeKind === "modified"
					? ("moved" as const)
					: file.changeKind,
			]),
		);
	}, [diffSession]);
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
	// Variant "dim the unchanged": while a review session marks rows, the
	// untouched entries recede so the action-colored changes are the only
	// thing at full contrast.
	const reviewFocus = changedFileKinds.size > 0;
	// A changed README previews as its diff — the review renders the change
	// itself, not the resulting document.
	const readmeDiff = useMemo<
		AtelierFileViewProps | { fileId: string; unavailable: true } | null
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
	const [actionError, setActionError] = useState<string | null>(null);
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
		[lix],
	);
	const { isDropTarget, dragHandlers } = useImportDrop({
		lix,
		dirPath,
		readOnly,
		onError: setActionError,
	});

	const createFile = useCallback(
		async (extension: "md" | "csv" | "excalidraw") => {
			try {
				setActionError(null);
				const path = await createRepositoryFile(lix, dirPath, extension);
				// Every type opens straight into its editor — naming up front is
				// friction. Markdown names itself from the first heading; csv and
				// drawings keep their untitled name until renamed.
				onOpenFile(path, { newTab: false, created: true });
			} catch (error) {
				console.error("repository-home: unable to create file", error);
				setActionError("Unable to create the file. Try again.");
			}
		},
		[dirPath, lix, onOpenFile],
	);

	useEffect(() => {
		if (
			!isActive ||
			!isHome ||
			tree === null ||
			repositoryTreeMarkedRef.current
		) {
			return;
		}
		repositoryTreeMarkedRef.current = true;
		markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.treeReady);
	}, [isActive, isHome, tree]);

	useEffect(() => {
		if (!isActive || readOnly || viewingHistory) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!event.metaKey ||
				event.key !== "." ||
				event.altKey ||
				event.ctrlKey
			) {
				return;
			}
			event.preventDefault();
			setActionError(null);
			if (event.shiftKey) {
				void createRepositoryFolder(lix, dirPath).catch((error: unknown) => {
					console.error("repository-home: new folder failed", error);
					setActionError("Unable to create the folder. Try again.");
				});
				return;
			}
			void createRepositoryFile(lix, dirPath, "md")
				.then((path) => onOpenFile(path, { newTab: false, created: true }))
				.catch((error: unknown) => {
					console.error("repository-home: new file failed", error);
					setActionError("Unable to create the file. Try again.");
				});
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [dirPath, isActive, lix, onOpenFile, readOnly, viewingHistory]);

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
					className="grid h-full w-full place-content-center px-6 text-center text-[13px] text-text-secondary"
				>
					Unable to load repository files. Reload to try again.
				</div>
			);
		}
		return <div className="h-full w-full" aria-busy="true" />;
	}

	return (
		<div
			className="@container relative flex h-full min-h-0 flex-col overflow-y-auto bg-bg-panel font-sans text-text-primary"
			{...dragHandlers}
		>
			{isDropTarget ? <DropImportOverlay /> : null}
			<div
				className={
					isHome
						? "mx-auto grid w-[min(1020px,calc(100%-48px))] grid-cols-[minmax(0,1fr)_244px] gap-12 pt-10 pb-10 @max-[1100px]:grid-cols-1 @max-[1100px]:gap-8"
						: "mx-auto flex w-[min(760px,calc(100%-48px))] flex-col pt-10 pb-10"
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
					{showGettingStarted ? null : (
						<div className="flex items-center gap-2 pb-5">
							<Breadcrumb
								dirPath={dirPath}
								onNavigate={(path, event) =>
									onOpenDir(path, { newTab: newTabFromMouseEvent(event) })
								}
							/>
							<span className="flex-1" />
							<div
								className={`flex shrink-0 items-center gap-2 transition-opacity${
									reviewFocus ? " opacity-[0.35] hover:opacity-100" : ""
								}`}
							>
								<NewMenu
									disabled={readOnly || viewingHistory}
									onCreateFile={(extension) => void createFile(extension)}
									onCreateFolder={() => {
										setActionError(null);
										void createRepositoryFolder(lix, dirPath).catch(
											(error: unknown) => {
												console.error(
													"repository-home: new folder failed",
													error,
												);
												setActionError(
													"Unable to create the folder. Try again.",
												);
											},
										);
									}}
								/>
							</div>
						</div>
					)}
					{actionError ? (
						<p
							role="alert"
							className="mb-3 rounded-lg bg-error-700/10 px-3 py-2 text-[13px] text-error-700"
						>
							{actionError}
						</p>
					) : null}
					{listing.dirs.length === 0 && listing.files.length === 0 ? (
						showGettingStarted && hasAgentConnected ? (
							<GettingStarted
								connection={connection}
								hasAgentConnected={hasAgentConnected}
								onCreateFile={(extension) => void createFile(extension)}
							/>
						) : (
							<div className="rounded-[10px] border border-dashed border-border-panel px-6 py-12 text-center text-[13px] leading-6 text-text-tertiary">
								{readOnly || viewingHistory ? (
									"No files yet."
								) : (
									<>
										No files yet — create one with{" "}
										<b className="font-semibold text-text-secondary">New</b>, or
										drop files anywhere to import.
									</>
								)}
							</div>
						)
					) : null}
					<div
						className="flex flex-col gap-px @max-[1100px]:max-h-[min(42vh,24rem)] @max-[1100px]:overflow-x-hidden @max-[1100px]:overflow-y-auto @max-[1100px]:pr-1"
						data-testid="home-entry-list"
					>
						{listing.dirs.map((dir) => (
							<EntryRow
								key={dir.path}
								icon={
									<img
										src="/icon-sq-folder.svg"
										alt=""
										className="size-[19px]"
									/>
								}
								name={dir.name}
								meta={`${dir.itemCount} ${dir.itemCount === 1 ? "item" : "items"}`}
								hidden={dir.hidden}
								active={
									entryMenu?.path === dir.path ||
									renameTarget?.path === dir.path
								}
								dimmed={reviewFocus && !changedDirKinds.has(dir.path)}
								{...(changedDirKinds.has(dir.path)
									? {
											changeKind: changedDirKinds.get(dir.path),
											// The softened dot marks mixed contents; a fully
											// new folder reads solid green like its files.
											dimIndicator:
												changedDirKinds.get(dir.path) === "modified",
										}
									: {})}
								onClick={(event) =>
									onOpenDir(dir.path, { newTab: newTabFromMouseEvent(event) })
								}
								{...(readOnly || viewingHistory
									? {}
									: {
											onContextMenu: (event: ReactMouseEvent) => {
												event.preventDefault();
												setEntryMenu({
													kind: "directory",
													name: dir.name,
													path: dir.path,
													x: event.clientX,
													y: event.clientY,
												});
											},
										})}
							/>
						))}
						{listing.files.map((file) => (
							<EntryRow
								key={file.path}
								testId="home-file-entry"
								fileId={file.id}
								icon={
									<img
										src={fileIconUrl(file.name)}
										alt=""
										className="size-[19px]"
									/>
								}
								name={file.name}
								meta={formatUpdatedAt(file.updatedAt)}
								hidden={file.hidden}
								active={
									entryMenu?.path === file.path ||
									renameTarget?.path === file.path
								}
								dimmed={reviewFocus && !changedFileKinds.has(file.path)}
								{...(changedFileKinds.has(file.path)
									? { changeKind: changedFileKinds.get(file.path) }
									: {})}
								onClick={(event) => {
									// A changed file opens through the diff session, keeping
									// the review float in step with the revealed document.
									if (
										changedFileKinds.has(file.path) &&
										onOpenDiffFile &&
										!newTabFromMouseEvent(event)
									) {
										onOpenDiffFile(file.path);
										return;
									}
									onOpenFile(file.path, {
										newTab: newTabFromMouseEvent(event),
									});
								}}
								{...(readOnly || viewingHistory
									? {}
									: {
											onContextMenu: (event: ReactMouseEvent) => {
												event.preventDefault();
												setEntryMenu({
													kind: "file",
													name: file.name,
													path: file.path,
													id: tree.files.find(
														(candidate) => candidate.path === file.path,
													)?.id,
													x: event.clientX,
													y: event.clientY,
												});
											},
										})}
							/>
						))}
					</div>
					{isHome ? (
						<RepositoryNarrowStats
							fileCount={tree.files.length}
							data={controlPlaneData}
							onOpenSqlExplorer={onOpenSqlExplorer}
							onOpenChangesReview={onOpenChangesReview}
							onOpenHistory={onOpenHistory}
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
								onOpen={(event) =>
									onOpenFile(listing.readmePath as string, {
										newTab: newTabFromMouseEvent(event),
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
								className="absolute flex min-w-[164px] flex-col rounded-[10px] border border-border-panel bg-bg-panel p-1 shadow-[0_10px_28px_rgba(28,25,23,0.14)]"
								style={{
									left: Math.min(entryMenu.x + 2, window.innerWidth - 180),
									top: Math.min(entryMenu.y + 2, window.innerHeight - 84),
								}}
								onClick={(event) => event.stopPropagation()}
							>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setRenameTarget(entryMenu);
										setEntryMenu(null);
									}}
									className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-none font-medium text-text-primary hover:bg-bg-hover"
								>
									<PencilLine
										className="size-3.5 text-icon-secondary"
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
									className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-none font-medium text-text-primary hover:bg-error-700/10 hover:text-error-700"
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
				{isHome ? (
					<RepositoryControlPlaneRail
						reviewFocus={reviewFocus}
						visibility={visibility}
						fileCount={tree.files.length}
						data={controlPlaneData}
						onOpenSettings={onOpenSettings}
						onOpenSqlExplorer={onOpenSqlExplorer}
						onOpenChangesReview={onOpenChangesReview}
						onOpenHistory={onOpenHistory}
						teamSection={
							detailsEnabled ? (
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
							) : null
						}
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
}: {
	/** Review focus: sections other than Changes recede with the page. */
	readonly reviewFocus?: boolean;
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
			className="min-w-0 @max-[1100px]:hidden"
		>
			{teamSection ? (
				<section className={`border-b border-border-panel pb-7${mutedSection}`}>
					<RailHeading>Team &amp; agents</RailHeading>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{teamSection}
					</div>
				</section>
			) : null}
			<section
				className={`border-b border-border-panel pb-7 ${teamSection ? "pt-7" : ""}${mutedSection}`}
			>
				<RailHeading>About</RailHeading>
				<button
					type="button"
					onClick={onOpenSettings}
					className="mt-3 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[7px] bg-[#f4eee5] px-2.5 text-[11.5px] font-bold text-[#57534e] transition-colors hover:bg-[#ebe2d6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
				>
					{visibility === "public" ? (
						<Globe2 className="size-3.5" aria-hidden="true" />
					) : (
						<LockKeyhole className="size-3.5" aria-hidden="true" />
					)}
					{visibility === "public" ? "Public" : "Private"}
				</button>
			</section>

			<section
				className={`border-b border-border-panel py-7 @max-[1100px]:border-t-0${mutedSection}`}
			>
				<RailHeading>Changes</RailHeading>
				{data?.changeHistoryUnavailable ? (
					<p
						role="status"
						className="m-0 mt-2 text-[11.5px] leading-4 text-text-tertiary"
					>
						Some change history is unavailable.
					</p>
				) : null}
				<ChangesSummary
					data={data}
					onOpenChangesReview={onOpenChangesReview}
					onOpenHistory={onOpenHistory}
				/>
			</section>

			<section className={`border-b border-border-panel py-7${mutedSection}`}>
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
}: {
	readonly fileCount: number;
	readonly data: RepositoryControlPlaneData | null;
	readonly onOpenSqlExplorer?: () => void;
	readonly onOpenChangesReview?: () => void;
	readonly onOpenHistory?: () => void;
}) {
	return (
		<aside
			aria-label="Repository statistics"
			className="mt-7 hidden min-w-0 grid-cols-2 gap-8 border-t border-border-panel px-3 pt-7 @max-[1100px]:grid @max-[640px]:grid-cols-1"
		>
			<section className="min-w-0">
				<RailHeading>Changes</RailHeading>
				{data?.changeHistoryUnavailable ? (
					<p
						role="status"
						className="m-0 mt-2 text-[11.5px] leading-4 text-text-tertiary"
					>
						Some change history is unavailable.
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

/** Quiet tonal chip, matching the About section's visibility chip. */
const RAIL_CHIP_CLASS =
	"h-7 gap-1.5 rounded-[7px] border-0 bg-[#f4eee5] px-2.5 text-[11.5px] font-bold text-[#57534e] shadow-none hover:bg-[#ebe2d6] hover:text-[#44403c] [&_img]:size-3 [&_svg]:size-3";

function RailHeading({ children }: { readonly children: ReactNode }) {
	return (
		<h2 className="m-0 text-[11.5px] font-bold tracking-[0.08em] text-text-quaternary uppercase">
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
		return (
			<div
				className="mt-4 h-11 border-b border-[#ded5c8] text-center text-[18px] leading-10 text-text-quaternary"
				aria-hidden="true"
			>
				—
			</div>
		);
	}
	const maxCount = Math.max(1, ...days.map((day) => day.count));
	const latestCheckpointDay = data.checkpointDates?.[0]?.slice(0, 10) ?? null;
	// Same day-granularity rule the bar colors use: a checkpoint splits the
	// window, and the headline counts the reviewable span after it.
	const headlineCount = latestCheckpointDay
		? days.reduce(
				(sum, entry) =>
					entry.day > latestCheckpointDay ? sum + entry.count : sum,
				0,
			)
		: (data.totalChangeCount ??
			days.reduce((sum, entry) => sum + entry.count, 0));
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
				<strong className="text-[20px] leading-none font-semibold tracking-[-0.03em] text-text-primary">
					{formatCompactCount(headlineCount)}
				</strong>
				<span className="text-[11.5px] text-text-tertiary">
					{headlineCount === 1 ? "change" : "changes"}
					{latestCheckpointDay ? " since checkpoint" : ""}
				</span>
			</div>
			<div className="mt-3 flex h-11 items-end gap-[3px] border-b border-[#ded5c8]">
				{paddedDays.map((entry, index) => {
					const afterCheckpoint =
						!latestCheckpointDay ||
						!entry.day ||
						entry.day > latestCheckpointDay;
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
										? "bg-[#e8590c]"
										: "bg-[#f0b48a]"
									: "bg-[#ebe2d4]"
							}`}
							style={{ height }}
							title={
								entry.day
									? `${entry.count} ${entry.count === 1 ? "change" : "changes"} on ${entry.day}`
									: undefined
							}
						/>
					);
				})}
			</div>
			<div className="mt-1.5 flex items-center justify-between text-[9.5px] text-text-quaternary">
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
					className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-[#c2410c] hover:text-[#9a3412] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
				>
					Review changes →
				</button>
			) : headlineCount === 0 && onOpenHistory ? (
				<button
					type="button"
					onClick={onOpenHistory}
					className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-[#c2410c] hover:text-[#9a3412] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
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
		{ label: "Files", count: fileCount, color: "bg-[#e8590c]" },
		{
			label: "Checkpoints",
			count: data.checkpointCount,
			color: "bg-[#d8cdbc]",
		},
		{
			label: "Changes",
			count: data.totalChangeCount,
			color: "bg-[#eeb17f]",
		},
	];

	return (
		<div className="mt-2.5">
			<div className="flex items-baseline gap-1.5">
				<strong className="text-[20px] leading-none font-semibold tracking-[-0.03em] text-text-primary">
					{data.tableCount === null ? "—" : formatCompactCount(data.tableCount)}
				</strong>
				<span className="text-[11.5px] text-text-tertiary">
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
						className="flex items-center gap-2 text-[11px] text-text-tertiary"
					>
						<span className={`size-1.5 rounded-full ${row.color}`} />
						<span>{row.label}</span>
						<span className="flex-1 border-b border-dotted border-border-panel" />
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
					className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-[#c2410c] hover:text-[#9a3412] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
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
							<span aria-hidden className="text-[12px] text-text-quaternary">
								/
							</span>
						) : null}
						{isCurrent ? (
							<span
								aria-current="location"
								className={`max-w-[220px] truncate px-2 ${
									index === 0 ? "text-text-quaternary" : "text-text-primary"
								}`}
							>
								{crumb.label}
							</span>
						) : (
							<button
								type="button"
								onClick={(event) => onNavigate(crumb.path, event)}
								className="flex h-[30px] max-w-[180px] cursor-pointer items-center truncate rounded-[7px] px-2 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible"
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
					className="flex cursor-pointer items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span className="flex -space-x-1.5">
						{team.slice(0, 3).map((member) => (
							<MemberAvatar
								key={member.accountId}
								member={member}
								className="size-6 text-[11px] ring-2 ring-bg-panel"
							/>
						))}
						{overflow > 0 ? (
							<span className="flex size-6 items-center justify-center rounded-full bg-bg-hover text-[10px] font-semibold text-text-secondary ring-2 ring-bg-panel">
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
	const dragDepthRef = useRef(0);
	const handleDrop = useCallback(
		(event: ReactDragEvent) => {
			event.preventDefault();
			dragDepthRef.current = 0;
			setIsDropTarget(false);
			if (readOnly) return;
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			onError(null);
			void importDroppedFiles(lix, dirPath, files)
				.then(({ failed }) => {
					if (failed.length > 0) {
						onError(
							`Could not import ${failed.length} ${failed.length === 1 ? "file" : "files"} (${failed.join(", ")}).`,
						);
					}
				})
				.catch((error: unknown) => {
					console.error("repository-home: import failed", error);
					onError("Unable to import the dropped files.");
				});
		},
		[dirPath, lix, onError, readOnly],
	);
	return {
		isDropTarget,
		dragHandlers: {
			onDragEnter: (event: ReactDragEvent) => {
				event.preventDefault();
				if (readOnly) return;
				dragDepthRef.current += 1;
				setIsDropTarget(true);
			},
			onDragOver: (event: ReactDragEvent) => {
				event.preventDefault();
			},
			onDragLeave: () => {
				dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
				if (dragDepthRef.current === 0) setIsDropTarget(false);
			},
			onDrop: handleDrop,
		},
	};
}

function DropImportOverlay() {
	return (
		<div className="pointer-events-none absolute inset-2 z-10 grid place-content-center rounded-xl border-2 border-dashed border-bg-action-primary bg-bg-panel/85 text-sm font-semibold text-text-secondary">
			Drop files to import
		</div>
	);
}

/**
 * Dot-hybrid diff glyphs (design 23d), mirroring atelier's: the familiar dot
 * silhouette with a knockout so change types survive grayscale and color
 * blindness. 12px, matching the history panel's listings.
 */
function DiffGlyph({
	kind,
	className,
}: {
	readonly kind: "added" | "modified" | "removed" | "moved";
	readonly className?: string;
}) {
	const fill =
		kind === "added"
			? "var(--color-border-diff-added)"
			: kind === "removed"
				? "var(--color-border-diff-removed)"
				: kind === "moved"
					? "var(--color-icon-diff-moved)"
					: "var(--color-icon-brand)";
	const knockout = "var(--color-bg-panel)";
	const title =
		kind === "added"
			? "Added in this review"
			: kind === "removed"
				? "Removed in this review"
				: kind === "moved"
					? "Moved in this review"
					: "Changed in this review";
	return (
		<span
			title={title}
			aria-label={title}
			className={`inline-flex ${className ?? ""}`}
		>
			<svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
				<circle cx="6" cy="6" r="5" fill={fill} />
				{kind === "added" ? (
					<path
						d="M6 3.6v4.8M3.6 6h4.8"
						stroke={knockout}
						strokeWidth="1.7"
						strokeLinecap="round"
					/>
				) : null}
				{kind === "removed" ? (
					<path
						d="M3.6 6h4.8"
						stroke={knockout}
						strokeWidth="1.7"
						strokeLinecap="round"
					/>
				) : null}
				{kind === "moved" ? (
					<path
						d="M4.8 3.6 7.2 6 4.8 8.4"
						stroke={knockout}
						strokeWidth="1.7"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				) : null}
			</svg>
		</span>
	);
}

function EntryRow({
	testId,
	fileId,
	icon,
	name,
	meta,
	hidden = false,
	changeKind,
	dimIndicator = false,
	dimmed = false,
	active = false,
	onClick,
	onContextMenu,
}: {
	readonly testId?: string;
	/** Stable file identity for tests and integrations; survives path renames. */
	readonly fileId?: string;
	readonly icon: ReactNode;
	readonly name: string;
	readonly meta: string;
	readonly hidden?: boolean;
	/**
	 * Marked by the open diff session; mirrors the sidebar's indicator.
	 * Shape + color (design 23d): added dot+plus green, removed dot+minus
	 * red, moved dot+chevron blue, modified the plain brand-orange dot.
	 */
	readonly changeKind?: "added" | "modified" | "removed" | "moved";
	/** Folders inherit a softened dot, matching the sidebar tree. */
	readonly dimIndicator?: boolean;
	/** Review focus: an unchanged row recedes; hover restores it. */
	readonly dimmed?: boolean;
	/** Keeps the row anchored while its context menu or dialog is open. */
	readonly active?: boolean;
	readonly onClick: (event: ReactMouseEvent) => void;
	readonly onContextMenu?: (event: ReactMouseEvent) => void;
}) {
	const changed = changeKind !== undefined;
	// In a review every changed name carries its action color — matching the
	// sidebar tree's label tinting — so the action reads without hunting for
	// the trailing glyph. Modified shares the tree's brand orange; moved the
	// glyph's blue. Folders that merely contain changes (the dim indicator)
	// keep a neutral name, like the tree's softened contains-changes dot.
	const nameClass =
		dimIndicator || changeKind === undefined
			? "text-text-primary"
			: changeKind === "added"
				? "text-[var(--color-text-diff-added)]"
				: changeKind === "removed"
					? "text-[var(--color-text-diff-removed)]"
					: changeKind === "modified"
						? "text-[var(--color-icon-brand)]"
						: "text-[var(--color-icon-diff-moved)]";
	return (
		<button
			type="button"
			data-testid={testId}
			data-file-id={fileId}
			onClick={onClick}
			onContextMenu={onContextMenu}
			className={`flex w-full items-center gap-3 rounded-[9px] px-3 py-2.25 text-left transition-opacity hover:bg-bg-hover ${
				active ? "bg-bg-hover " : ""
			}${
				hidden
					? "opacity-[0.48] hover:opacity-[0.62]"
					: dimmed
						? "opacity-[0.35] hover:opacity-100"
						: ""
			}`}
			data-hidden-entry={hidden ? "true" : undefined}
			data-changed-entry={changed ? "true" : undefined}
		>
			{icon}
			<span
				className={`text-sm font-medium ${nameClass}`}
				data-testid={fileId ? "home-entry-name" : undefined}
			>
				{name}
			</span>
			<span className="flex-1" />
			{/* In a review, the trailing slot carries the same orange change dot
			    the sidebar tree uses, replacing the resting meta. */}
			{changed && changeKind ? (
				<DiffGlyph
					kind={changeKind}
					className={`shrink-0 ${dimIndicator ? "opacity-75" : ""}`}
				/>
			) : (
				<span className="text-[12.5px] text-text-quaternary">{meta}</span>
			)}
		</button>
	);
}

function ReadmePreview({
	lix,
	sourceFilePath,
	fileId,
	diff,
	fileName,
	onOpen,
	onNavigate,
}: {
	readonly lix: Lix;
	readonly sourceFilePath: string;
	readonly fileId: string | null;
	/** Present while a review marks the README; renders the diff itself. */
	readonly diff:
		| AtelierFileViewProps
		| { fileId: string; unavailable: true }
		| null;
	readonly fileName: string;
	readonly onOpen: (event: ReactMouseEvent) => void;
	/** Returns true when the link was handled inside the tab model. */
	readonly onNavigate: (href: string, event?: ReactMouseEvent) => boolean;
}) {
	if (!fileId) return null;
	return (
		<>
			<div className="flex items-center gap-1.5 px-3 pt-8 pb-3.5">
				<button
					type="button"
					onClick={onOpen}
					className="text-[13px] font-semibold text-text-secondary hover:text-text-primary"
				>
					{fileName}
				</button>
				<button
					type="button"
					aria-label={`Edit ${fileName}`}
					title={`Edit ${fileName}`}
					onClick={onOpen}
					className="grid size-6 shrink-0 place-content-center rounded-md text-icon-tertiary hover:bg-bg-hover hover:text-icon-secondary"
				>
					<PencilLine aria-hidden="true" className="size-3" />
				</button>
				<span className="ml-1 h-px flex-1 bg-border-subtle" />
			</div>
			{/* Relative README links navigate the tab in place (rule 3) instead
			    of escaping to a full page load. */}
			{/* Click delegation only augments the anchors inside, which stay
			    keyboard-accessible on their own. */}
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
				className="px-3 pb-5"
			>
				{/* Quick Look: the extension that owns the file type renders
				    the preview — and during a review, the diff — so every
				    state shares the editor's own presentation. */}
				{diff && "unavailable" in diff ? (
					<div role="alert">
						The working diff changed while it was being reviewed. Reopen the
						review.
					</div>
				) : (
					<Atelier.FileView
						readOnly
						{...(diff ?? { lix, fileId, filePath: sourceFilePath })}
					/>
				)}
			</div>
		</>
	);
}

const NEW_FILE_KINDS = [
	{
		extension: "md",
		label: "New Markdown",
		hint: "(.md)",
		testId: "home-create-file-md",
	},
	{
		extension: "csv",
		label: "New CSV",
		hint: "(.csv)",
		testId: "home-create-file-csv",
	},
	{
		extension: "excalidraw",
		label: "New Drawing",
		hint: "(.excalidraw)",
		testId: "home-create-file-excalidraw",
	},
] as const;

function NewMenu({
	disabled = false,
	onCreateFile,
	onCreateFolder,
}: {
	readonly disabled?: boolean;
	readonly onCreateFile: (extension: "md" | "csv" | "excalidraw") => void;
	readonly onCreateFolder: () => void;
}) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	return (
		<div ref={containerRef} className="relative">
			<Button
				type="button"
				variant="featured"
				className="h-9 gap-1.5 px-3.5 text-[13.5px] font-bold"
				disabled={disabled}
				aria-expanded={open}
				data-testid="home-new-button"
				onClick={() => setOpen((current) => !current)}
			>
				<Plus className="size-3.5" aria-hidden="true" />
				New
				<ChevronDown className="size-3 opacity-80" aria-hidden="true" />
			</Button>
			{open ? (
				<div className="absolute top-11 right-0 z-20 flex w-[248px] flex-col rounded-xl border border-border-panel bg-bg-panel p-1.5 shadow-[0_18px_44px_rgba(28,25,23,0.16)]">
					<MenuItem
						icon={<img src="/icon-sq-new.svg" alt="" className="size-4" />}
						label="New file"
						shortcut="⌘ ."
						onClick={() => {
							setOpen(false);
							onCreateFile("md");
						}}
					/>
					<MenuItem
						icon={<img src="/icon-sq-folder.svg" alt="" className="size-4" />}
						label="New folder"
						shortcut="⇧⌘ ."
						onClick={() => {
							setOpen(false);
							onCreateFolder();
						}}
					/>
					<span className="mx-1 my-1.5 h-px bg-border-subtle" />
					{NEW_FILE_KINDS.map((kind) => (
						<MenuItem
							key={kind.extension}
							icon={
								<img
									src={fileIconUrl(`file.${kind.extension}`)}
									alt=""
									className="size-4"
								/>
							}
							label={kind.label}
							hint={kind.hint}
							testId={kind.testId}
							onClick={() => {
								setOpen(false);
								onCreateFile(kind.extension);
							}}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

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
			className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(28,25,23,0.28)]"
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-label={`Rename ${target.name}`}
				className="w-[340px] rounded-xl border border-border-panel bg-bg-panel p-4 shadow-[0_18px_44px_rgba(28,25,23,0.24)]"
				onClick={(event) => event.stopPropagation()}
			>
				<h2 className="m-0 text-[13.5px] font-bold text-text-primary">
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
					className="mt-3 h-9 w-full rounded-lg border border-border-panel bg-bg-app px-2.5 text-[13.5px] text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible"
				/>
				{error ? (
					<p role="alert" className="mt-2 mb-0 text-[12.5px] text-error-700">
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

function MenuItem({
	icon,
	label,
	hint,
	shortcut,
	testId,
	onClick,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly hint?: string;
	readonly shortcut?: string;
	readonly testId?: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onClick}
			className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-none font-medium text-text-primary hover:bg-bg-hover"
		>
			{icon}
			<span className="flex-1">
				{label}
				{hint ? <span className="text-text-tertiary"> {hint}</span> : null}
			</span>
			{shortcut ? (
				<span className="text-[11.5px] text-text-tertiary/60">{shortcut}</span>
			) : null}
		</button>
	);
}

/**
 * Illustration for the getting-started state: a sketched document card with
 * agent icons feeding into it along dashed paths (12f in the comp).
 */
function GettingStartedIllustration() {
	return (
		<div aria-hidden="true" className="relative mb-6 h-[118px] w-[300px]">
			<div className="absolute top-0 left-1/2 flex w-[230px] -translate-x-1/2 rotate-[-1.5deg] flex-col gap-[7px] rounded-[10px] border border-border-panel bg-bg-panel px-3.5 py-3 shadow-[0_10px_26px_rgba(28,25,23,0.09)]">
				<div className="flex items-center gap-[7px]">
					<img src={fileIconUrl("file.md")} alt="" className="size-[13px]" />
					<span className="h-[7px] w-24 rounded bg-[#E4DDD1]" />
					<span className="flex-1" />
					<span className="inline-flex size-[15px] items-center justify-center rounded-[4.5px] bg-[#FAF4EC] shadow-[inset_0_0_0_1px_#EDE2D2]">
						<img
							src="/landing/claude-spark.svg"
							alt=""
							className="size-[9px]"
						/>
					</span>
				</div>
				<div className="flex items-center gap-[7px]">
					<img src={fileIconUrl("file.csv")} alt="" className="size-[13px]" />
					<span className="h-[7px] w-[68px] rounded bg-[#ECE8E2]" />
					<span className="flex-1" />
					<img src="/landing/codex-icon.svg" alt="" className="size-[15px]" />
				</div>
				<div className="flex items-center gap-[7px]">
					<img
						src={fileIconUrl("file.excalidraw")}
						alt=""
						className="size-[13px]"
					/>
					<span className="h-[7px] w-[118px] rounded bg-[#ECE8E2]" />
				</div>
			</div>
			<span className="absolute bottom-3.5 left-2 inline-flex size-[34px] rotate-[-6deg] items-center justify-center rounded-[10px] bg-[#FAF4EC] shadow-[inset_0_0_0_1px_#EDE2D2,0_6px_14px_rgba(28,25,23,0.08)]">
				<img src="/landing/claude-spark.svg" alt="" className="size-[19px]" />
			</span>
			<img
				src="/landing/codex-icon.svg"
				alt=""
				className="absolute right-2.5 bottom-3 size-[34px] rotate-[5deg] drop-shadow-[0_6px_14px_rgba(28,25,23,0.12)]"
			/>
			<svg
				width="46"
				height="30"
				viewBox="0 0 46 30"
				fill="none"
				stroke="#D8CFC2"
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
				stroke="#D8CFC2"
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
function GettingStarted({
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
					<p className="mt-3 mb-0 max-w-[470px] text-[14.5px] leading-[1.6] text-text-secondary">
						A shared folder for you and your AI agents. Connect Claude, Codex,
						or Cursor — everything it writes lands here, with full change
						history.
					</p>
					<button
						type="button"
						onClick={() => setConnectDialogOpen(true)}
						className="mt-5.5 mb-10.5 inline-flex items-center gap-2 rounded-[10px] bg-[linear-gradient(180deg,var(--color-bg-action-primary-start)_0%,var(--color-bg-action-primary-end)_100%)] px-4.5 py-2.75 text-sm font-bold text-text-on-action-primary shadow-[var(--shadow-action-primary)] hover:brightness-105"
					>
						<Link2 className="size-3.5" aria-hidden="true" />
						Connect an agent
					</button>
					<div className="mb-3.5 text-[11.5px] font-bold tracking-[0.06em] text-text-quaternary uppercase">
						or start yourself
					</div>
					<div className="flex justify-center gap-2.5">
						{NEW_FILE_KINDS.map((kind) => (
							<button
								key={kind.extension}
								type="button"
								data-testid={kind.testId}
								onClick={() => onCreateFile(kind.extension)}
								className="inline-flex items-center gap-2 rounded-[9px] bg-bg-hover px-3.5 py-2.5 text-[13px] font-semibold text-text-secondary hover:bg-bg-active"
							>
								<img
									src={fileIconUrl(`file.${kind.extension}`)}
									alt=""
									className="size-4"
								/>
								{kind.label.replace("New ", "")}
							</button>
						))}
					</div>
					<div className="mt-4.5 text-xs text-text-quaternary">
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
			<DialogContent className="max-h-[calc(100vh-2rem)] w-[min(520px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto rounded-2xl border-border-panel bg-bg-panel p-0 text-text-primary shadow-[0_30px_90px_rgba(28,25,23,0.3)] sm:max-w-none">
				<DialogHeader className="gap-1.5 px-8 pt-8 pr-14 text-left">
					<DialogTitle className="text-lg leading-tight font-bold tracking-[-0.01em]">
						Connect an agent
					</DialogTitle>
					<DialogDescription className="text-[13.5px] leading-[1.55] text-text-secondary">
						Copy the prompt into Claude, ChatGPT, or Gemini. It handles the
						rest.
					</DialogDescription>
				</DialogHeader>

				<div className="px-8">
					<ConnectionStep number={1} label="Copy the prompt" active />
					<button
						type="button"
						onClick={() => void copyPrompt()}
						className="inline-flex items-center gap-2 rounded-[10px] bg-[linear-gradient(180deg,var(--color-bg-action-primary-start)_0%,var(--color-bg-action-primary-end)_100%)] px-4.5 py-2.75 text-sm font-bold text-text-on-action-primary shadow-[var(--shadow-action-primary)] hover:brightness-105"
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
								className={`absolute inset-0 grid place-items-center rounded-full bg-white transition-all duration-150 ${
									copyState === "copied"
										? "scale-100 opacity-100"
										: "scale-75 opacity-0"
								}`}
							>
								<Check
									className="size-3 text-[var(--color-text-status-success)]"
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

					<ConnectionStep number={2} label="Paste it into your AI chat" />
					{/* A looping 7s mock of the copy-paste-send moment (12g), staged
					    inside a fake browser window (traffic-light navbar, page area)
					    so the chat reads as the user's own browser tab — not a real
					    input. The cursor presses Copy prompt, carries it down, pastes,
					    and sends. Reduced motion shows the pasted end state statically. */}
					<div className="rounded-[14px] shadow-[0_10px_28px_rgba(28,25,23,0.18)]">
						<div
							aria-hidden="true"
							className="flex items-center gap-2.5 rounded-t-[14px] border-b border-white/10 bg-[#2C2C2C] px-3 py-2"
						>
							<span className="flex items-center gap-1.5">
								<span className="size-2.5 rounded-full bg-[#FF5F57]" />
								<span className="size-2.5 rounded-full bg-[#FEBC2E]" />
								<span className="size-2.5 rounded-full bg-[#28C840]" />
							</span>
							<span className="flex items-center gap-1 text-[#8A8A8A]">
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
							<span className="flex flex-1 items-center gap-1.5 rounded-[7px] bg-[#1F1F1F] px-2.5 py-1.5 text-[11px] font-medium text-[#9A9A9A]">
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
						<div className="rounded-b-[14px] bg-[#141414] p-4">
							<div className="relative rounded-[14px] bg-[#212121] px-4 pt-3.5 pb-3 text-left shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
								<div className="relative h-[21px] text-[13.5px]">
									<span
										aria-hidden="true"
										className="absolute top-0 left-0 text-[#6B6B6B] animate-connect-placeholder motion-reduce:hidden"
									>
										<span className="mr-[3px] inline-block h-[15px] w-[1.5px] bg-[#E5E5E5] align-text-bottom animate-connect-caret" />
										Do anything
									</span>
									<span className="absolute top-0 left-0 inline-flex rounded-[5px] bg-[rgba(232,89,12,0.16)] px-[7px] py-0.5 font-mono text-xs text-[#F0A47C] opacity-0 animate-connect-chip motion-reduce:opacity-100 motion-reduce:animate-none">
										[prompt]
									</span>
								</div>
								<div className="mt-4 flex items-center gap-3">
									<span className="text-base leading-none text-[#8A8A8A]">
										＋
									</span>
									<span className="flex-1" />
									<span className="relative inline-flex size-[26px] items-center justify-center rounded-full bg-[#3A3A3A] animate-connect-send motion-reduce:animate-none">
										<ArrowUp
											className="size-3.5 text-[#E5E5E5] animate-connect-send-arrow motion-reduce:animate-none"
											aria-hidden="true"
										/>
										<span className="absolute inset-0 flex items-center justify-center opacity-0 animate-connect-spinner-show motion-reduce:hidden">
											<span className="box-border size-[13px] rounded-full border-2 border-white/25 border-t-white animate-connect-spin" />
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
										className="drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
									>
										<path
											d="M1 1l0 14.5 3.9-3.4 2.5 6 2.7-1.1-2.5-5.9 5.4-.4z"
											fill="#FFFFFF"
											stroke="#1C1917"
											strokeWidth="1.3"
											strokeLinejoin="round"
										/>
									</svg>
									<span className="absolute top-4 left-4 inline-flex gap-1 opacity-0 animate-connect-keys">
										<span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md bg-[#FBF6F0] px-[5px] text-[11px] font-bold text-[#1C1917] shadow-[0_2px_0_#C9C2B8,0_4px_10px_rgba(0,0,0,0.4)]">
											⌘
										</span>
										<span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md bg-[#FBF6F0] text-[11px] font-bold text-[#1C1917] shadow-[0_2px_0_#C9C2B8,0_4px_10px_rgba(0,0,0,0.4)]">
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
						className="inline-flex items-center gap-2.5 rounded-[10px] bg-bg-hover px-4.5 py-2.75 text-[13.5px] font-semibold text-text-secondary"
						data-testid="agent-connection-status"
					>
						{connectionStatus === "connected" ? (
							<>
								<span className="inline-flex size-4 items-center justify-center rounded-full bg-success-600 text-white">
									<Check className="size-2.5" aria-hidden="true" />
								</span>
								Agent connected
							</>
						) : (
							<>
								<span className="size-2 rounded-full bg-bg-action-primary animate-connect-dot-pulse motion-reduce:animate-none" />
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
						? "inline-flex size-[18px] items-center justify-center rounded-full bg-text-primary text-[10.5px] font-bold text-bg-panel"
						: "inline-flex size-[18px] items-center justify-center rounded-full bg-bg-hover text-[10.5px] font-bold text-text-secondary"
				}
			>
				{number}
			</span>
			<span className="text-xs font-bold tracking-[0.05em] text-text-secondary uppercase">
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
