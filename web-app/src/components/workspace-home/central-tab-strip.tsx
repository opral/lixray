import type {
	AtelierTabStripContext,
	AtelierTabStripTab,
} from "@opral/atelier";
import { LIXRAY_DIR_EXTENSION_ID } from "./host-extensions";
import { fileIconUrl } from "@opral/atelier/file-icons";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The central tab strip rendered to the home comp's spec (15a/12b): white
 * active chip, transparent inactive chips, the pinned Home compacting to its
 * icon, and a quiet ＋. Tab semantics stay in Atelier — this is pixels only.
 */
export function LixrayCentralTabStrip({
	context,
	pinnedTab,
}: {
	readonly context: AtelierTabStripContext;
	/** Overrides the pinned tab's presentation (e.g. "Getting started"). */
	readonly pinnedTab?: {
		readonly label: string;
		readonly icon: AtelierTabStripTab["icon"];
	};
}) {
	return (
		<div className="flex h-[var(--atelier-panel-header-height)] min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
		</div>
	);
}

function TabChip({ tab }: { readonly tab: AtelierTabStripTab }) {
	// The pinned Home compacts to its icon while a content tab is active —
	// "the house is always one click" — and the collapse/expand animates.
	const showLabel = !tab.isPinned || tab.isActive;
	const chipRef = useRef<HTMLButtonElement | null>(null);
	// Keep the active chip in view when the strip overflows (browser tabs).
	useEffect(() => {
		if (tab.isActive) {
			chipRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
		}
	}, [tab.isActive]);
	const stateClasses = tab.isActive
		? "border-border-panel bg-bg-panel px-3 font-semibold text-text-primary"
		: tab.isPinned
			? "border-transparent px-[7px] font-medium text-text-tertiary hover:bg-bg-hover"
			: "border-transparent px-3 font-medium text-text-tertiary hover:bg-bg-hover hover:text-text-primary";
	return (
		<button
			ref={chipRef}
			type="button"
			aria-label={tab.label}
			title={showLabel ? undefined : tab.label}
			onClick={tab.select}
			data-active={tab.isActive ? "true" : undefined}
			className={`flex h-7 items-center rounded-[7px] border text-[12.5px] transition-all duration-200 ease-out ${
				tab.isPinned ? "shrink-0" : "min-w-9 shrink"
			} ${stateClasses}`}
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
					className="ml-1 size-[11px] text-icon-quaternary hover:text-icon-secondary"
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
	// File tabs get their file-type icon and folder tabs the colored square
	// folder (comp 15a/12d); other views use the extension's own icon in the
	// quiet secondary tint.
	if (tab.kind === LIXRAY_DIR_EXTENSION_ID) {
		return (
			<img src="/icon-sq-folder.svg" alt="" className="size-3.5 shrink-0" />
		);
	}
	const hasFileExtension = /\.[a-z0-9]+$/i.test(tab.label);
	if (!tab.isPinned && hasFileExtension) {
		return (
			<img src={fileIconUrl(tab.label)} alt="" className="size-3.5 shrink-0" />
		);
	}
	return (
		<span className="text-icon-secondary">
			<tab.icon className="size-3.5 shrink-0" />
		</span>
	);
}
