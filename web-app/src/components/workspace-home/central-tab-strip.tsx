import type {
	AtelierTabStripContext,
	AtelierTabStripTab,
} from "@opral/atelier";
import { fileIconUrl } from "@opral/atelier/file-icons";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The central tab strip rendered to the home comp's spec (15a/12b): white
 * active chip, transparent inactive chips, the pinned Home compacting to its
 * icon, and a quiet ＋. Tab semantics stay in Atelier — this is pixels only.
 */
export function LixrayCentralTabStrip({
	context,
	onCreateFile,
	onCreateFolder,
	pinnedTab,
}: {
	readonly context: AtelierTabStripContext;
	readonly onCreateFile?: (
		extension: "md" | "csv" | "excalidraw",
	) => void | Promise<void>;
	readonly onCreateFolder?: () => void | Promise<void>;
	/** Overrides the pinned tab's presentation (e.g. "Getting started"). */
	readonly pinnedTab?: {
		readonly label: string;
		readonly icon: AtelierTabStripTab["icon"];
	};
}) {
	const canAdd = onCreateFile !== undefined || context.newTab !== undefined;
	return (
		<div className="flex h-[var(--atelier-panel-header-height)] items-center gap-1">
			{context.tabs.map((tab) => (
				<TabChip
					key={tab.instanceId}
					tab={
						tab.isPinned && pinnedTab
							? { ...tab, label: pinnedTab.label, icon: pinnedTab.icon }
							: tab
					}
				/>
			))}
			{canAdd ? (
				<NewTabMenu
					onCreateFile={onCreateFile}
					onCreateFolder={onCreateFolder}
					fallbackNewTab={context.newTab}
				/>
			) : null}
		</div>
	);
}

/**
 * The strip's ＋ opens the add-view menu (same vocabulary as the sidebar ＋):
 * pick what the new tab should be rather than instantly creating a file.
 */
function NewTabMenu({
	onCreateFile,
	onCreateFolder,
	fallbackNewTab,
}: {
	readonly onCreateFile?: (
		extension: "md" | "csv" | "excalidraw",
	) => void | Promise<void>;
	readonly onCreateFolder?: () => void | Promise<void>;
	readonly fallbackNewTab?: () => void;
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
	if (!onCreateFile) {
		return (
			<button
				type="button"
				aria-label="New tab"
				data-testid="lixray-new-tab"
				onClick={fallbackNewTab}
				className="grid size-[26px] shrink-0 place-content-center rounded-md text-[15px] leading-none text-text-tertiary hover:bg-bg-hover"
			>
				＋
			</button>
		);
	}
	return (
		<div ref={containerRef} className="relative">
			<button
				type="button"
				aria-label="New tab"
				aria-expanded={open}
				data-testid="lixray-new-tab"
				onClick={() => setOpen((current) => !current)}
				className="grid size-[26px] shrink-0 place-content-center rounded-md text-[15px] leading-none text-text-tertiary hover:bg-bg-hover"
			>
				＋
			</button>
			{open ? (
				<div className="absolute top-8 left-0 z-20 flex w-[248px] flex-col rounded-xl border border-border-panel bg-bg-panel p-1.5 shadow-[0_18px_44px_rgba(28,25,23,0.16)]">
					<StripMenuItem
						icon={<img src="/icon-sq-new.svg" alt="" className="size-4" />}
						label="New file"
						shortcut="⌘ ."
						onClick={() => {
							setOpen(false);
							void onCreateFile("md");
						}}
					/>
					{onCreateFolder ? (
						<StripMenuItem
							icon={<img src="/icon-sq-folder.svg" alt="" className="size-4" />}
							label="New folder"
							shortcut="⇧⌘ ."
							onClick={() => {
								setOpen(false);
								void onCreateFolder();
							}}
						/>
					) : null}
					<span className="mx-1 my-1.5 h-px bg-border-subtle" />
					{(
						[
							["md", "New Markdown", "(.md)"],
							["csv", "New CSV", "(.csv)"],
							["excalidraw", "New Drawing", "(.excalidraw)"],
						] as const
					).map(([extension, label, hint]) => (
						<StripMenuItem
							key={extension}
							icon={
								<img
									src={fileIconUrl(`file.${extension}`)}
									alt=""
									className="size-4"
								/>
							}
							label={label}
							hint={hint}
							onClick={() => {
								setOpen(false);
								void onCreateFile(extension);
							}}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function StripMenuItem({
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

function TabChip({ tab }: { readonly tab: AtelierTabStripTab }) {
	// The pinned Home compacts to its icon while a content tab is active —
	// "the house is always one click" — and the collapse/expand animates.
	const showLabel = !tab.isPinned || tab.isActive;
	const stateClasses = tab.isActive
		? "border-border-panel bg-bg-panel px-3 font-semibold text-text-primary"
		: tab.isPinned
			? "border-transparent px-[7px] font-medium text-text-tertiary hover:bg-bg-hover"
			: "border-transparent px-3 font-medium text-text-tertiary hover:bg-bg-hover hover:text-text-primary";
	return (
		<button
			type="button"
			aria-label={tab.label}
			title={showLabel ? undefined : tab.label}
			onClick={tab.select}
			data-active={tab.isActive ? "true" : undefined}
			className={`flex h-7 shrink-0 items-center rounded-[7px] border text-[12.5px] transition-all duration-200 ease-out ${stateClasses}`}
		>
			<TabIcon tab={tab} />
			<span
				aria-hidden={showLabel ? undefined : true}
				className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin-left] duration-200 ease-out ${
					showLabel ? "ml-[7px] max-w-40 opacity-100" : "ml-0 max-w-0 opacity-0"
				} ${tab.isPending ? "italic" : ""}`}
			>
				{tab.label}
			</span>
			{tab.close ? (
				<X
					aria-hidden="true"
					className="ml-1 size-[11px] text-text-tertiary/70 hover:text-text-secondary"
					onClick={(event) => {
						event.stopPropagation();
						tab.close?.();
					}}
				/>
			) : null}
		</button>
	);
}

function TabIcon({ tab }: { readonly tab: AtelierTabStripTab }): ReactNode {
	// File tabs get their file-type icon (comp 15a); other views use the
	// extension's own icon.
	const hasFileExtension = /\.[a-z0-9]+$/i.test(tab.label);
	if (!tab.isPinned && hasFileExtension) {
		return (
			<img src={fileIconUrl(tab.label)} alt="" className="size-3.5 shrink-0" />
		);
	}
	return <tab.icon className="size-3.5 shrink-0" />;
}
