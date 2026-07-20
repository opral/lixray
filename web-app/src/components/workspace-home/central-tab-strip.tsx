import type {
	AtelierTabStripContext,
	AtelierTabStripTab,
} from "@opral/atelier";
import { fileIconUrl } from "@opral/atelier/file-icons";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The central tab strip rendered to the home comp's spec (15a/12b): white
 * active chip, transparent inactive chips, the pinned Home compacting to its
 * icon, and a quiet ＋. Tab semantics stay in Atelier — this is pixels only.
 */
export function LixrayCentralTabStrip({
	context,
}: {
	readonly context: AtelierTabStripContext;
}) {
	return (
		<div className="flex items-center gap-1 pt-0.5 pb-1.5">
			{context.tabs.map((tab) => (
				<TabChip key={tab.instanceId} tab={tab} />
			))}
			{context.newTab ? (
				<button
					type="button"
					aria-label="New tab"
					data-testid="lixray-new-tab"
					onClick={context.newTab}
					className="grid size-[26px] shrink-0 place-content-center rounded-md text-[15px] leading-none text-text-tertiary hover:bg-bg-hover"
				>
					＋
				</button>
			) : null}
		</div>
	);
}

function TabChip({ tab }: { readonly tab: AtelierTabStripTab }) {
	// The pinned Home compacts to its icon while a content tab is active —
	// "the house is always one click" without repeating its name.
	if (tab.isPinned && !tab.isActive) {
		return (
			<button
				type="button"
				aria-label={tab.label}
				title={tab.label}
				onClick={tab.select}
				className="grid size-7 shrink-0 place-content-center rounded-[7px] text-text-tertiary hover:bg-bg-hover"
			>
				<tab.icon className="size-3.5" />
			</button>
		);
	}
	return (
		<button
			type="button"
			onClick={tab.select}
			data-active={tab.isActive ? "true" : undefined}
			className={
				tab.isActive
					? "flex h-7 shrink-0 items-center gap-[7px] rounded-[7px] border border-border-panel bg-bg-panel px-3 text-[12.5px] font-semibold text-text-primary"
					: "flex h-7 shrink-0 items-center gap-[7px] rounded-[7px] border border-transparent px-3 text-[12.5px] font-medium text-text-secondary hover:bg-bg-hover"
			}
		>
			<TabIcon tab={tab} />
			<span className={tab.isPending ? "italic" : undefined}>{tab.label}</span>
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
