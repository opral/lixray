import { fileIconUrl } from "@opral/atelier/file-icons";
import {
	Check,
	Copy,
	Globe2,
	LockKeyhole,
	MessageSquare,
	Users,
} from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type CopyState = "idle" | "copied";

export type ReadShareAccess =
	| { status: "private"; canPublish: boolean }
	| {
			status: "published";
			source: "resource" | "repository" | "ancestor";
			canUnpublish: boolean;
			inheritedFrom?: string;
	  };

interface RepositoryShareDialogProps {
	/** The canonical URL of what is open, without any invite capability. */
	canonicalUrl: string;
	documentName: string;
	/**
	 * What the link opens. Files, folders and the repository can be published;
	 * a conversation cannot, so its read access follows the repository and
	 * a private repository's members can still copy its link.
	 */
	publicationLabel: "file" | "folder" | "conversation" | "repository";
	readAccess: ReadShareAccess | null;
	/** An optional composed trigger owned by the surrounding shell. */
	trigger?: ReactElement;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onCopied?: (url: string, mode: "public" | "members") => void;
	publishReadLink: () => Promise<void>;
	unpublishReadLink: () => Promise<void>;
	/** Opens the repository People tab, where membership invitations live. */
	onOpenTeam?: () => void;
	className?: string;
}

async function copyText(value: string) {
	if (!navigator.clipboard?.writeText) {
		throw new Error("Clipboard access is unavailable.");
	}
	await navigator.clipboard.writeText(value);
}

export function RepositoryShareDialog({
	canonicalUrl,
	documentName,
	publicationLabel,
	readAccess,
	trigger,
	open,
	onOpenChange,
	onCopied,
	publishReadLink,
	unpublishReadLink,
	onOpenTeam,
	className,
}: RepositoryShareDialogProps) {
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState<"publish" | "unpublish" | null>(null);
	const isPublished = readAccess?.status === "published";
	// A private conversation is still worth linking: members open it.
	const isMembersLink =
		publicationLabel === "conversation" && readAccess?.status === "private";
	const canCopy = isPublished || isMembersLink;
	const documentIconUrl = fileIconUrl(documentName);

	useEffect(() => {
		setCopyState("idle");
		setErrorMessage(null);
	}, [canonicalUrl, readAccess]);

	const selectLinkText = (element: HTMLElement) => {
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	};

	const handleCopy = async () => {
		if (!canCopy) return;
		try {
			await copyText(canonicalUrl);
		} catch {
			setErrorMessage(
				"Couldn’t copy the link. Select it above and copy it manually.",
			);
			return;
		}

		setCopyState("copied");
		onCopied?.(canonicalUrl, isPublished ? "public" : "members");
	};

	const runPermissionChange = async (
		kind: "publish" | "unpublish",
		action: () => Promise<void>,
	) => {
		if (busy) return;
		setBusy(kind);
		setCopyState("idle");
		setErrorMessage(null);
		try {
			await action();
		} catch {
			setErrorMessage(
				kind === "publish"
					? `Couldn’t publish this ${publicationLabel}.`
					: `Couldn’t unpublish this ${publicationLabel}.`,
			);
		} finally {
			setBusy(null);
		}
	};

	const publishLabel =
		publicationLabel === "repository"
			? "Make repository public"
			: `Publish ${publicationLabel}`;
	const unpublishLabel =
		publicationLabel === "repository"
			? "Make repository private"
			: `Unpublish ${publicationLabel}`;

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
					onOpenAutoFocus={(event) => event.preventDefault()}
					className={cn(
						"z-50 grid w-[min(384px,calc(100vw-2rem))] gap-3.5 rounded-xl border border-border bg-panel p-[18px] text-fg shadow-[0_18px_50px_color-mix(in_srgb,var(--atelier-overlay)_18%,transparent),0_2px_8px_color-mix(in_srgb,var(--atelier-overlay)_8%,transparent)] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
						className,
					)}
				>
					<div className="flex items-center gap-2.5">
						{publicationLabel === "repository" ? null : publicationLabel ===
						  "conversation" ? (
							<MessageSquare
								className="size-[18px] shrink-0 text-fg-muted"
								aria-hidden="true"
							/>
						) : (
							<img
								src={documentIconUrl}
								alt=""
								className="size-[22px] shrink-0"
							/>
						)}
						<h2 className="min-w-0 truncate text-sm font-bold">
							Share {documentName}
						</h2>
					</div>

					<div
						className={cn(
							"flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs",
							isPublished
								? "border-success-subtle bg-success-subtle text-diff-added"
								: "border-border-subtle bg-bg-hover text-fg-muted",
						)}
					>
						{isPublished ? (
							<Globe2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						) : (
							<LockKeyhole
								className="mt-0.5 size-3.5 shrink-0 text-fg-subtle"
								aria-hidden="true"
							/>
						)}
						<span className="leading-5">
							{readAccess === null
								? "Checking publication status…"
								: readAccess.status === "private"
									? publicationLabel === "conversation"
										? "Only repository members can open this conversation."
										: `This ${publicationLabel} is private.`
									: readAccess.source === "ancestor"
										? `Public through ${readAccess.inheritedFrom ?? "a published parent folder"}.`
										: readAccess.source === "repository"
											? "Public because the repository is public."
											: `This ${publicationLabel} is published.`}
						</span>
					</div>

					{canCopy ? (
						<div className="flex min-w-0 items-stretch gap-2 max-[420px]:flex-col">
							<div
								className="flex h-9 min-w-0 grow cursor-text select-all items-center overflow-hidden rounded-lg border border-border bg-panel px-3 font-mono text-[11px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
								tabIndex={0}
								role="textbox"
								aria-readonly="true"
								aria-label={`${isPublished ? "Public link" : "Members-only link"}: ${canonicalUrl}`}
								title={canonicalUrl}
								onClick={(event) => selectLinkText(event.currentTarget)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										selectLinkText(event.currentTarget);
									}
								}}
							>
								<span className="block truncate">{canonicalUrl}</span>
							</div>
							<Button
								type="button"
								variant="featured"
								onClick={() => void handleCopy()}
								className="shrink-0 font-semibold max-[420px]:w-full"
							>
								{copyState === "copied" ? (
									<Check aria-hidden="true" />
								) : (
									<Copy aria-hidden="true" />
								)}
								{copyState === "copied" ? "Copied" : "Copy link"}
							</Button>
						</div>
					) : readAccess?.status === "private" ? (
						<Button
							type="button"
							variant="featured"
							disabled={!readAccess.canPublish || busy !== null}
							onClick={() =>
								void runPermissionChange("publish", publishReadLink)
							}
						>
							{busy === "publish" ? "Publishing…" : publishLabel}
						</Button>
					) : null}

					<p className="text-xs leading-5 text-fg-subtle" aria-live="polite">
						{errorMessage ? (
							<span className="text-danger-border" role="alert">
								{errorMessage}
							</span>
						) : isMembersLink ? (
							<>
								A conversation follows the repository’s access: members can open
								this link.
							</>
						) : readAccess?.status === "private" ? (
							readAccess.canPublish ? (
								publicationLabel === "folder" ? (
									<>
										Publishing makes this folder and everything below it
										readable by anyone with the link.
									</>
								) : publicationLabel === "repository" ? (
									<>
										Anyone can read a public repository. Only members can edit.
									</>
								) : (
									<>
										Publishing makes this file readable by anyone with the link.
									</>
								)
							) : (
								<>Only a repository admin can make the repository public.</>
							)
						) : (
							<>Anyone who opens the public link can read {documentName}.</>
						)}
					</p>

					{readAccess?.status === "published" && readAccess.canUnpublish ? (
						<button
							type="button"
							disabled={busy !== null}
							onClick={() =>
								void runPermissionChange("unpublish", unpublishReadLink)
							}
							className="w-fit text-xs font-semibold text-fg-muted underline decoration-border-strong underline-offset-4 hover:text-fg disabled:opacity-50"
						>
							{busy === "unpublish" ? "Updating…" : unpublishLabel}
						</button>
					) : null}

					{onOpenTeam ? (
						<button
							type="button"
							onClick={onOpenTeam}
							className="-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-xs font-semibold text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							<Users
								className="size-3.5 shrink-0 text-fg-subtle"
								aria-hidden="true"
							/>
							Invite your team
						</button>
					) : null}
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
