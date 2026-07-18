import { fileIconUrl } from "@opral/atelier/file-icons";
import { Check, Copy } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type ShareMode = "edit" | "read";
type CopyState = "idle" | "copied" | "error";

export interface WorkspaceShareDialogProps {
	/** The public, canonical resource URL. */
	canonicalUrl: string;
	/** The canonical resource URL with its opaque `invite` capability token. */
	editableUrl: string;
	documentName: string;
	workspaceName: string;
	/**
	 * An optional composed trigger. Pass a single button-like element when the
	 * surrounding shell owns the Share button.
	 */
	trigger?: ReactElement;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Called after the link has been written to the clipboard. */
	onCopied?: (url: string, mode: ShareMode) => void;
	className?: string;
}

async function copyText(value: string) {
	if (!navigator.clipboard?.writeText) {
		throw new Error("Clipboard access is unavailable.");
	}
	await navigator.clipboard.writeText(value);
}

export function WorkspaceShareDialog({
	canonicalUrl,
	editableUrl,
	documentName,
	workspaceName,
	trigger,
	open,
	onOpenChange,
	onCopied,
	className,
}: WorkspaceShareDialogProps) {
	const [shareMode, setShareMode] = useState<ShareMode>("edit");
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const copiedUrl = shareMode === "edit" ? editableUrl : canonicalUrl;
	const isEditableLink = shareMode === "edit";
	const documentIconUrl = fileIconUrl(documentName);

	useEffect(() => {
		setCopyState("idle");
	}, [copiedUrl]);

	const selectLinkText = (element: HTMLElement) => {
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	};

	const handleCopy = async () => {
		try {
			await copyText(copiedUrl);
		} catch {
			setCopyState("error");
			return;
		}

		setCopyState("copied");
		onCopied?.(copiedUrl, shareMode);
	};

	return (
		<PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<PopoverPrimitive.Trigger asChild>
				{trigger ?? (
					<Button size="sm" variant="outline" type="button">
						Share
					</Button>
				)}
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					align="end"
					sideOffset={8}
					aria-label={`Share ${documentName}`}
					className={cn(
						"z-50 grid w-[min(420px,calc(100vw-2rem))] gap-4 rounded-xl border border-border-panel bg-bg-panel p-4 text-text-primary shadow-xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
						className,
					)}
				>
					<div className="flex items-center gap-2.5">
						<img src={documentIconUrl} alt="" className="size-7 shrink-0" />
						<h2 className="min-w-0 truncate text-sm font-semibold">
							Share {documentName}
						</h2>
					</div>

					<div className="flex min-w-0 items-stretch gap-2 max-[420px]:flex-col">
						<div
							className="flex h-9 min-w-0 grow cursor-text select-all items-center overflow-hidden rounded-lg border border-border-panel bg-bg-panel px-3 font-mono text-xs text-text-secondary focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring-focus-visible"
							tabIndex={0}
							role="textbox"
							aria-readonly="true"
							aria-label={`${isEditableLink ? "Editable" : "Read-only"} link: ${copiedUrl}`}
							title={copiedUrl}
							onClick={(event) => selectLinkText(event.currentTarget)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									selectLinkText(event.currentTarget);
								}
							}}
						>
							<span className="block truncate">{copiedUrl}</span>
						</div>
						<Button
							type="button"
							variant="featured"
							onClick={() => void handleCopy()}
							className="shrink-0 max-[420px]:w-full"
						>
							{copyState === "copied" ? (
								<Check aria-hidden="true" />
							) : (
								<Copy aria-hidden="true" />
							)}
							{copyState === "copied" ? "Copied" : "Copy link"}
						</Button>
					</div>

					<div
						className="inline-flex w-fit overflow-hidden rounded-lg border border-border-panel bg-bg-panel-muted p-0.5"
						role="radiogroup"
						aria-label="Link access"
					>
						<ShareModeButton
							active={isEditableLink}
							onClick={() => setShareMode("edit")}
						>
							Can edit
						</ShareModeButton>
						<ShareModeButton
							active={!isEditableLink}
							onClick={() => setShareMode("read")}
						>
							Read only
						</ShareModeButton>
					</div>

					<p
						className="text-xs leading-5 text-text-secondary"
						aria-live="polite"
					>
						{copyState === "error" ? (
							<span className="text-error-700" role="alert">
								Couldn’t copy the link. Select it above and copy it manually.
							</span>
						) : copyState === "copied" ? (
							<>Link copied to clipboard.</>
						) : isEditableLink ? (
							<>
								Anyone with this link can read {documentName} and join{" "}
								{workspaceName} as an editor.
							</>
						) : (
							<>Anyone with this link can read {documentName}.</>
						)}
					</p>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

function ShareModeButton({
	active,
	children,
	onClick,
}: {
	active: boolean;
	children: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={active}
			onClick={onClick}
			className={cn(
				"rounded-md px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible",
				active && "bg-bg-panel text-text-primary shadow-sm",
			)}
		>
			{children}
		</button>
	);
}
