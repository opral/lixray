import {
	ChevronDown,
	Download,
	FilePlus2,
	FolderPlus,
	FolderUp,
	GitBranch,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { Branch } from "~/lib/lixray-api";

export interface ExplorerToolbarProps {
	branches: Array<Branch>;
	activeBranchId: string;
	onBranchChange: (branchId: string) => void;
	selectedCount: number;
	busy: boolean;
	onNewFolder: () => void;
	onUploadFiles: () => void;
	onUploadFolder: () => void;
	onDownloadSelected: () => void;
	onDeleteSelected: () => void;
	onClearSelection: () => void;
}

export function ExplorerToolbar({
	branches,
	activeBranchId,
	onBranchChange,
	selectedCount,
	busy,
	onNewFolder,
	onUploadFiles,
	onUploadFolder,
	onDownloadSelected,
	onDeleteSelected,
	onClearSelection,
}: ExplorerToolbarProps) {
	const activeBranch = branches.find((branch) => branch.id === activeBranchId);

	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			{selectedCount > 0 ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						onClick={onClearSelection}
						aria-label="Clear selection"
					>
						<X aria-hidden="true" />
					</Button>
					<span className="text-sm text-muted-foreground">
						{selectedCount} selected
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={onDownloadSelected}
						disabled={busy}
					>
						<Download aria-hidden="true" />
						Download
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="text-destructive hover:text-destructive"
						onClick={onDeleteSelected}
						disabled={busy}
					>
						<Trash2 aria-hidden="true" />
						Delete
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="sm" disabled={busy || !activeBranchId}>
								<Upload aria-hidden="true" />
								Upload
								<ChevronDown aria-hidden="true" className="opacity-60" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuItem onSelect={onUploadFiles}>
								<FilePlus2 aria-hidden="true" />
								Files…
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={onUploadFolder}>
								<FolderUp aria-hidden="true" />
								Folder…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						variant="outline"
						size="sm"
						onClick={onNewFolder}
						disabled={busy || !activeBranchId}
					>
						<FolderPlus aria-hidden="true" />
						New folder
					</Button>
				</div>
			)}
			{branches.length > 0 ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" size="sm" aria-label="Switch branch">
							<GitBranch aria-hidden="true" />
							{activeBranch?.name ?? "Branch"}
							<ChevronDown aria-hidden="true" className="opacity-60" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{branches
							.filter((branch) => !branch.hidden)
							.map((branch) => (
								<DropdownMenuItem
									key={branch.id}
									onSelect={() => onBranchChange(branch.id)}
									data-active={branch.id === activeBranchId}
									className="data-[active=true]:bg-accent"
								>
									<GitBranch aria-hidden="true" />
									{branch.name}
								</DropdownMenuItem>
							))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</div>
	);
}
