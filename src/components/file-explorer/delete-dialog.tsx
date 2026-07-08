import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { buttonVariants } from "~/components/ui/button";
import type { ExplorerEntry } from "~/lib/file-explorer-api";

export function DeleteDialog({
	entries,
	onConfirm,
	onOpenChange,
}: {
	entries: Array<ExplorerEntry>;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
}) {
	const hasDirs = entries.some((entry) => entry.kind === "dir");
	const label =
		entries.length === 1
			? `“${entries[0].name}”`
			: `${entries.length} items`;

	return (
		<AlertDialog open={entries.length > 0} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {label}?</AlertDialogTitle>
					<AlertDialogDescription>
						{hasDirs
							? "Folders are deleted with all of their contents. This cannot be undone."
							: "This cannot be undone."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						className={buttonVariants({ variant: "destructive" })}
						onClick={onConfirm}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
