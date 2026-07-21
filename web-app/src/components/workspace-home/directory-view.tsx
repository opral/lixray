import type { Lix } from "@lix-js/sdk";
import { fileIconUrl } from "@opral/atelier/file-icons";
import DOMPurify from "dompurify";
import { ChevronDown, Link2, PencilLine, Plus, Sparkles } from "lucide-react";
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

export type DirectoryViewProps = {
	readonly lix: Lix;
	/** Normalized trailing-slash directory path; "/" is the workspace home. */
	readonly dirPath: string;
	/** The pinned home shows the connect row and the getting-started state. */
	readonly isHome: boolean;
	readonly readOnly: boolean;
	readonly connectHref: string;
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
	connectHref,
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
	const [isDropTarget, setIsDropTarget] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const dragDepthRef = useRef(0);

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

	const handleDrop = useCallback(
		(event: ReactDragEvent) => {
			event.preventDefault();
			dragDepthRef.current = 0;
			setIsDropTarget(false);
			if (readOnly) return;
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			setActionError(null);
			void importDroppedFiles(lix, dirPath, files)
				.then(({ failed }) => {
					if (failed.length > 0) {
						setActionError(
							`Could not import ${failed.length} ${failed.length === 1 ? "file" : "files"} (${failed.join(", ")}).`,
						);
					}
				})
				.catch((error: unknown) => {
					console.error("workspace-home: import failed", error);
					setActionError("Unable to import the dropped files.");
				});
		},
		[dirPath, lix, readOnly],
	);

	if (!tree || !listing) {
		return <div className="h-full w-full" aria-busy="true" />;
	}

	const isWorkspaceEmpty =
		isHome && tree.dirs.length === 0 && tree.files.length === 0;

	return (
		<div
			className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-bg-panel font-sans text-text-primary"
			onDragEnter={(event) => {
				event.preventDefault();
				if (readOnly) return;
				dragDepthRef.current += 1;
				setIsDropTarget(true);
			}}
			onDragOver={(event) => {
				event.preventDefault();
			}}
			onDragLeave={() => {
				dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
				if (dragDepthRef.current === 0) setIsDropTarget(false);
			}}
			onDrop={handleDrop}
		>
			{isDropTarget ? (
				<div className="pointer-events-none absolute inset-2 z-10 grid place-content-center rounded-xl border-2 border-dashed border-bg-action-primary bg-bg-panel/85 text-sm font-semibold text-text-secondary">
					Drop files to import
				</div>
			) : null}
			{isWorkspaceEmpty ? (
				<GettingStarted
					readOnly={readOnly}
					connectHref={connectHref}
					onCreateFile={(extension) => void createFile(extension)}
				/>
			) : (
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
								Working from Claude, Codex, or another agent? Connect it to this
								workspace.
							</span>
							<span className="flex-1" />
							<a
								href={connectHref}
								target="_blank"
								rel="noreferrer"
								className="inline-flex h-7 shrink-0 items-center rounded-[7px] border border-border-action-secondary bg-bg-panel px-3 text-xs font-semibold whitespace-nowrap text-text-secondary shadow-action-secondary hover:bg-bg-hover"
							>
								Connect an agent
							</a>
						</div>
					) : null}
					<div className="flex flex-col gap-px" data-testid="home-entry-list">
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
			)}
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
 * Shown only while the workspace has zero files: connect an agent, start a
 * document yourself, or drop files anywhere to import (12f in the comp).
 */
function GettingStarted({
	readOnly,
	connectHref,
	onCreateFile,
}: {
	readonly readOnly: boolean;
	readonly connectHref: string;
	readonly onCreateFile: (extension: "md" | "csv" | "excalidraw") => void;
}) {
	return (
		<div
			className="flex h-full min-h-0 flex-col items-center justify-center text-center"
			data-testid="home-getting-started"
		>
			<div className="flex w-[min(560px,calc(100%-48px))] flex-col items-center">
				<span className="mb-[18px] grid size-8 place-content-center rounded-[9px] bg-[#FAF4EC] shadow-[inset_0_0_0_1px_#EDE2D2]">
					<Sparkles
						className="size-4.5 text-text-secondary"
						aria-hidden="true"
					/>
				</span>
				<h1 className="m-0 text-2xl font-bold tracking-[-0.02em]">
					Let your agent write the first document
				</h1>
				<a
					href={connectHref}
					target="_blank"
					rel="noreferrer"
					className="mt-5 mb-10 inline-flex items-center gap-2 rounded-[10px] bg-[linear-gradient(180deg,var(--color-bg-action-primary-start)_0%,var(--color-bg-action-primary-end)_100%)] px-4.5 py-2.75 text-sm font-bold text-text-on-action-primary shadow-[var(--shadow-action-primary)] hover:brightness-105"
				>
					<Link2 className="size-3.5" aria-hidden="true" />
					Connect an agent
				</a>
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
