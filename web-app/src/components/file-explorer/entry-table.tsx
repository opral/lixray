import { Link } from "@tanstack/react-router";
import { Download, EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import type { ExplorerEntry } from "~/lib/file-explorer-api";
import { formatRelativeTime, formatSize } from "~/lib/format";
import { EntryIcon } from "./file-icon";

export interface EntryTableProps {
	entries: Array<ExplorerEntry>;
	namespace: string;
	workspaceSlug: string;
	selected: Set<string>;
	onSelectedChange: (next: Set<string>) => void;
	onDownload: (entry: ExplorerEntry) => void;
	onRename: (entry: ExplorerEntry) => void;
	onDelete: (entry: ExplorerEntry) => void;
}

const nameCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

export function EntryTable({
	entries,
	namespace,
	workspaceSlug,
	selected,
	onSelectedChange,
	onDownload,
	onRename,
	onDelete,
}: EntryTableProps) {
	const sorted = useMemo(
		() =>
			[...entries].sort((a, b) => {
				if (a.kind !== b.kind) {
					return a.kind === "dir" ? -1 : 1;
				}
				return nameCollator.compare(a.name, b.name);
			}),
		[entries],
	);

	const allSelected =
		sorted.length > 0 && sorted.every((entry) => selected.has(entry.id));
	const someSelected = sorted.some((entry) => selected.has(entry.id));

	const toggleAll = () => {
		onSelectedChange(
			allSelected ? new Set() : new Set(sorted.map((entry) => entry.id)),
		);
	};

	const toggleOne = (id: string) => {
		const next = new Set(selected);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		onSelectedChange(next);
	};

	return (
		<Table>
			<TableHeader>
				<TableRow className="hover:bg-transparent">
					<TableHead className="w-10">
						<Checkbox
							checked={
								allSelected ? true : someSelected ? "indeterminate" : false
							}
							onCheckedChange={toggleAll}
							aria-label="Select all"
						/>
					</TableHead>
					<TableHead>Name</TableHead>
					<TableHead className="w-28">Size</TableHead>
					<TableHead className="w-40">Modified</TableHead>
					<TableHead className="w-12" />
				</TableRow>
			</TableHeader>
			<TableBody>
				{sorted.map((entry) => (
					<TableRow
						key={entry.id}
						data-testid="entry-row"
						data-state={selected.has(entry.id) ? "selected" : undefined}
						onDoubleClick={() => {
							if (entry.kind === "file") {
								onDownload(entry);
							}
						}}
					>
						<TableCell>
							<Checkbox
								checked={selected.has(entry.id)}
								onCheckedChange={() => toggleOne(entry.id)}
								aria-label={`Select ${entry.name}`}
							/>
						</TableCell>
						<TableCell className="font-medium">
							{entry.kind === "dir" ? (
								<Link
									to="/@{$namespace}/$workspace"
									params={{ namespace, workspace: workspaceSlug }}
									search={{ dir: entry.path }}
									className="inline-flex items-center gap-2 hover:underline"
									data-testid="entry-name"
								>
									<EntryIcon kind="dir" name={entry.name} />
									{entry.name}
								</Link>
							) : (
								<span
									className="inline-flex items-center gap-2"
									data-testid="entry-name"
								>
									<EntryIcon kind="file" name={entry.name} />
									{entry.name}
								</span>
							)}
						</TableCell>
						<TableCell className="text-muted-foreground">
							{entry.kind === "file" ? formatSize(entry.size) : "—"}
						</TableCell>
						<TableCell className="text-muted-foreground">
							<time
								dateTime={entry.updatedAt}
								title={new Date(entry.updatedAt).toLocaleString()}
							>
								{formatRelativeTime(entry.updatedAt)}
							</time>
						</TableCell>
						<TableCell>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-8"
										aria-label={`Actions for ${entry.name}`}
									>
										<EllipsisVertical aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem onSelect={() => onDownload(entry)}>
										<Download aria-hidden="true" />
										Download{entry.kind === "dir" ? " as zip" : ""}
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => onRename(entry)}>
										<Pencil aria-hidden="true" />
										Rename
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										variant="destructive"
										onSelect={() => onDelete(entry)}
									>
										<Trash2 aria-hidden="true" />
										Delete
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
