import type { Lix } from "@lix-js/sdk";
import { fileIconUrl } from "@opral/atelier/file-icons";
import DOMPurify from "dompurify";
import {
	Check,
	ChevronDown,
	Copy,
	Link2,
	PencilLine,
	Plus,
} from "lucide-react";
import { marked } from "marked";
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
	createLixConnectionDetails,
	type LixConnectionPromptInput,
} from "~/lib/lix-connection-prompt";
import {
	createWorkspaceFile,
	createWorkspaceFolder,
	formatUpdatedAt,
	importDroppedFiles,
	listDirectory,
	normalizeHomeDirPath,
	resolveWorkspaceHref,
	useFileMarkdown,
	useWorkspaceTree,
} from "./lix-data";

type DirectoryViewProps = {
	readonly lix: Lix;
	/** Normalized trailing-slash directory path; "/" is the workspace home. */
	readonly dirPath: string;
	/** The pinned home shows the connect row. */
	readonly isHome: boolean;
	readonly readOnly: boolean;
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	/** Only the active view binds shortcuts (several stay mounted hidden). */
	readonly isActive?: boolean;
	readonly onOpenFile: (
		path: string,
		options: { newTab: boolean; created?: boolean },
	) => void;
	readonly onOpenDir: (dirPath: string, options: { newTab: boolean }) => void;
};

const newTabFromMouseEvent = (event: ReactMouseEvent): boolean =>
	event.metaKey || event.ctrlKey;

/**
 * The workspace home / folder view rendered inside Atelier's central tabs.
 * Folders first, then files, then the directory's README rendered below —
 * the tab names the location, so the view carries no title of its own.
 */
export function DirectoryView({
	lix,
	dirPath,
	isHome,
	readOnly,
	connection,
	isActive = true,
	onOpenFile,
	onOpenDir,
}: DirectoryViewProps) {
	const tree = useWorkspaceTree(lix);
	const listing = useMemo(
		() => (tree ? listDirectory(tree, dirPath) : null),
		[tree, dirPath],
	);
	const readme = useFileMarkdown(lix, listing?.readmePath ?? null);
	const [actionError, setActionError] = useState<string | null>(null);
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
				const path = await createWorkspaceFile(lix, dirPath, extension);
				onOpenFile(path, { newTab: false, created: true });
			} catch (error) {
				console.error("workspace-home: unable to create file", error);
				setActionError("Unable to create the file. Try again.");
			}
		},
		[dirPath, lix, onOpenFile],
	);

	useEffect(() => {
		if (!isActive || readOnly) return;
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
				void createWorkspaceFolder(lix, dirPath).catch((error: unknown) => {
					console.error("workspace-home: new folder failed", error);
					setActionError("Unable to create the folder. Try again.");
				});
				return;
			}
			void createWorkspaceFile(lix, dirPath, "md")
				.then((path) => onOpenFile(path, { newTab: false, created: true }))
				.catch((error: unknown) => {
					console.error("workspace-home: new file failed", error);
					setActionError("Unable to create the file. Try again.");
				});
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [dirPath, isActive, lix, onOpenFile, readOnly]);

	if (!tree || !listing) {
		return <div className="h-full w-full" aria-busy="true" />;
	}

	return (
		<div
			className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-bg-panel font-sans text-text-primary"
			{...dragHandlers}
		>
			{isDropTarget ? <DropImportOverlay /> : null}
			<div className="mx-auto flex w-[min(760px,calc(100%-48px))] flex-col pt-10 pb-10">
				{readOnly ? null : (
					<div className="flex items-center pb-5">
						<span className="flex-1" />
						<NewMenu
							onCreateFile={(extension) => void createFile(extension)}
							onCreateFolder={() => {
								setActionError(null);
								void createWorkspaceFolder(lix, dirPath).catch(
									(error: unknown) => {
										console.error("workspace-home: new folder failed", error);
										setActionError("Unable to create the folder. Try again.");
									},
								);
							}}
						/>
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
				{isHome ? (
					<div className="mb-4 flex items-center gap-3 rounded-[10px] border border-dashed border-border-action-secondary px-4 py-3">
						<Link2
							className="size-4 shrink-0 text-text-tertiary"
							aria-hidden="true"
						/>
						<span className="text-[13px] text-text-secondary">
							Connect this agent to my Lix workspace. LixRay hosts it.
						</span>
						<span className="flex-1" />
						<AgentConnectionActions connection={connection} compact />
					</div>
				) : null}
				<div className="flex flex-col gap-px" data-testid="home-entry-list">
					{listing.dirs.map((dir) => (
						<EntryRow
							key={dir.path}
							icon={
								<img src="/icon-sq-folder.svg" alt="" className="size-[19px]" />
							}
							name={dir.name}
							meta={`${dir.itemCount} ${dir.itemCount === 1 ? "item" : "items"}`}
							onClick={(event) =>
								onOpenDir(dir.path, { newTab: newTabFromMouseEvent(event) })
							}
						/>
					))}
					{listing.files.map((file) => (
						<EntryRow
							key={file.path}
							icon={
								<img
									src={fileIconUrl(file.name)}
									alt=""
									className="size-[19px]"
								/>
							}
							name={file.name}
							meta={formatUpdatedAt(file.updatedAt)}
							onClick={(event) =>
								onOpenFile(file.path, { newTab: newTabFromMouseEvent(event) })
							}
						/>
					))}
				</div>
				{listing.readmePath && readme !== null ? (
					<ReadmePreview
						fileName={
							listing.readmePath.split("/").filter(Boolean).at(-1) ?? ""
						}
						markdown={readme}
						onOpen={(event) =>
							onOpenFile(listing.readmePath as string, {
								newTab: newTabFromMouseEvent(event),
							})
						}
						onNavigate={(href, event) => {
							const resolved = resolveWorkspaceHref(dirPath, href);
							if (!resolved) return false;
							const asDir = normalizeHomeDirPath(resolved);
							const isDir =
								href.endsWith("/") ||
								tree.dirs.some((dir) => dir.path === asDir);
							if (isDir) {
								onOpenDir(asDir, {
									newTab: newTabFromMouseEvent(event),
								});
							} else {
								onOpenFile(resolved, {
									newTab: newTabFromMouseEvent(event),
								});
							}
							return true;
						}}
					/>
				) : null}
			</div>
		</div>
	);
}

/**
 * The standalone Getting started tab: the default active tab while the
 * workspace is empty, opened next to — never replacing — the pinned Home.
 */
export function GettingStartedView({
	lix,
	readOnly,
	connection,
	onOpenFile,
}: {
	readonly lix: Lix;
	readonly readOnly: boolean;
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly onOpenFile: (
		path: string,
		options: { newTab: boolean; created?: boolean },
	) => void;
}) {
	const [actionError, setActionError] = useState<string | null>(null);
	const { isDropTarget, dragHandlers } = useImportDrop({
		lix,
		dirPath: "/",
		readOnly,
		onError: setActionError,
	});
	const createFile = async (extension: "md" | "csv" | "excalidraw") => {
		try {
			setActionError(null);
			const path = await createWorkspaceFile(lix, "/", extension);
			onOpenFile(path, { newTab: false, created: true });
		} catch (error) {
			console.error("workspace-home: unable to create file", error);
			setActionError("Unable to create the file. Try again.");
		}
	};
	return (
		<div
			className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-bg-panel font-sans text-text-primary"
			{...dragHandlers}
		>
			{isDropTarget ? <DropImportOverlay /> : null}
			{actionError ? (
				<p
					role="alert"
					className="absolute inset-x-6 top-4 z-10 mx-auto max-w-[440px] rounded-lg bg-error-700/10 px-3 py-2 text-center text-[13px] text-error-700"
				>
					{actionError}
				</p>
			) : null}
			<GettingStarted
				readOnly={readOnly}
				connection={connection}
				onCreateFile={(extension) => void createFile(extension)}
			/>
		</div>
	);
}

/**
 * Drag-and-drop file import shared by the directory and getting-started
 * views; the caller renders {@link DropImportOverlay} and surfaces errors.
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
					console.error("workspace-home: import failed", error);
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

function EntryRow({
	icon,
	name,
	meta,
	onClick,
}: {
	readonly icon: ReactNode;
	readonly name: string;
	readonly meta: string;
	readonly onClick: (event: ReactMouseEvent) => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2.25 text-left hover:bg-bg-hover"
		>
			{icon}
			<span className="text-sm font-medium text-text-primary">{name}</span>
			<span className="flex-1" />
			<span className="text-[12.5px] text-text-quaternary">{meta}</span>
		</button>
	);
}

function ReadmePreview({
	fileName,
	markdown,
	onOpen,
	onNavigate,
}: {
	readonly fileName: string;
	readonly markdown: string;
	readonly onOpen: (event: ReactMouseEvent) => void;
	/** Returns true when the link was handled inside the tab model. */
	readonly onNavigate: (href: string, event: ReactMouseEvent) => boolean;
}) {
	const html = useMemo(
		() => DOMPurify.sanitize(marked.parse(markdown, { async: false })),
		[markdown],
	);
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
				className="px-3 pb-5 text-[15px] leading-[1.7] text-text-primary [&_a]:font-semibold [&_a]:text-text-link [&_code]:rounded [&_code]:bg-bg-hover [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-[-0.02em] [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-bold [&_li]:my-1 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</>
	);
}

const NEW_FILE_KINDS = [
	{ extension: "md", label: "New Markdown", hint: "(.md)" },
	{ extension: "csv", label: "New CSV", hint: "(.csv)" },
	{ extension: "excalidraw", label: "New Drawing", hint: "(.excalidraw)" },
] as const;

function NewMenu({
	onCreateFile,
	onCreateFolder,
}: {
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

function MenuItem({
	icon,
	label,
	hint,
	shortcut,
	onClick,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly hint?: string;
	readonly shortcut?: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
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
 * The empty-workspace pitch (12f in the comp): connect an agent, start a
 * document yourself, or drop files anywhere to import.
 */
function GettingStarted({
	readOnly,
	connection,
	onCreateFile,
}: {
	readonly readOnly: boolean;
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly onCreateFile: (extension: "md" | "csv" | "excalidraw") => void;
}) {
	return (
		<div
			className="flex h-full min-h-0 flex-col items-center justify-center text-center"
			data-testid="home-getting-started"
		>
			<div className="-mt-5 flex w-[min(560px,calc(100%-48px))] flex-col items-center">
				<GettingStartedIllustration />
				<h1 className="m-0 text-2xl font-bold tracking-[-0.02em]">
					Connect this agent to my Lix workspace
				</h1>
				<p className="mt-3 mb-0 max-w-[440px] text-[14.5px] leading-[1.6] text-text-secondary">
					LixRay hosts your Lix workspace. Copy the prompt into Claude, Codex,
					Cursor, or another agent to connect it and choose what to ingest.
				</p>
				<div className="mt-5.5 mb-10.5">
					<AgentConnectionActions connection={connection} />
				</div>
				{readOnly ? null : (
					<>
						<div className="mb-3.5 text-[11.5px] font-bold tracking-[0.06em] text-text-quaternary uppercase">
							or start yourself
						</div>
						<div className="flex justify-center gap-2.5">
							{NEW_FILE_KINDS.map((kind) => (
								<button
									key={kind.extension}
									type="button"
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
					</>
				)}
			</div>
		</div>
	);
}

function AgentConnectionActions({
	connection,
	compact = false,
}: {
	readonly connection: Omit<LixConnectionPromptInput, "origin">;
	readonly compact?: boolean;
}) {
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
			window.setTimeout(() => setCopyState("idle"), 2_000);
		} catch (error) {
			console.error("workspace-home: unable to copy agent prompt", error);
			setCopyState("error");
		}
	};

	return (
		<div
			className={
				compact
					? "flex shrink-0 items-center gap-2"
					: "flex flex-col items-center gap-2"
			}
		>
			<button
				type="button"
				onClick={() => void copyPrompt()}
				className={
					compact
						? "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] border border-border-action-secondary bg-bg-panel px-3 text-xs font-semibold whitespace-nowrap text-text-secondary shadow-action-secondary hover:bg-bg-hover"
						: "inline-flex items-center gap-2 rounded-[10px] bg-[linear-gradient(180deg,var(--color-bg-action-primary-start)_0%,var(--color-bg-action-primary-end)_100%)] px-4.5 py-2.75 text-sm font-bold text-text-on-action-primary shadow-[var(--shadow-action-primary)] hover:brightness-105"
				}
			>
				{copyState === "copied" ? (
					<Check className="size-3.5" aria-hidden="true" />
				) : (
					<Copy className="size-3.5" aria-hidden="true" />
				)}
				{copyState === "copied"
					? "Prompt copied"
					: copyState === "copying"
						? "Copying…"
						: copyState === "error"
							? "Copy failed"
							: "Copy setup prompt"}
			</button>
			{compact ? null : (
				<a
					href={details.documentationUrl}
					target="_blank"
					rel="noreferrer"
					className="text-xs font-medium text-text-tertiary hover:text-text-secondary hover:underline"
				>
					MCP setup docs
				</a>
			)}
		</div>
	);
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
