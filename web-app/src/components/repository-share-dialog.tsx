import { fileIconUrl } from "@opral/atelier/file-icons";
import { Check, Copy, Globe2, LockKeyhole, Users } from "lucide-react";
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
	/** The public, canonical resource URL. */
	canonicalUrl: string;
	documentName: string;
	publicationLabel: "file" | "folder" | "repository";
	readAccess: ReadShareAccess | null;
	/** An optional composed trigger owned by the surrounding shell. */
	trigger?: ReactElement;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onCopied?: (url: string) => void;
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
		if (!isPublished) return;
		try {
			await copyText(canonicalUrl);
		} catch {
			setErrorMessage(
				"Couldn’t copy the link. Select it above and copy it manually.",
			);
			return;
		}

		setCopyState("copied");
		onCopied?.(canonicalUrl);
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
						"z-50 grid w-[min(384px,calc(100vw-2rem))] gap-3.5 rounded-xl border border-border-panel bg-bg-panel p-[18px] text-text-primary shadow-[0_18px_50px_rgba(28,25,23,0.18),0_2px_8px_rgba(28,25,23,0.08)] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
						className,
					)}
				>
					<div className="flex items-center gap-2.5">
						{publicationLabel === "repository" ? null : (
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
								? "border-success-200 bg-success-50 text-success-800"
								: "border-border-subtle bg-bg-hover text-text-secondary",
						)}
					>
						{isPublished ? (
							<Globe2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						) : (
							<LockKeyhole
								className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
								aria-hidden="true"
							/>
						)}
						<span className="leading-5">
							{readAccess === null
								? "Checking publication status…"
								: readAccess.status === "private"
									? `This ${publicationLabel} is private.`
									: readAccess.source === "ancestor"
										? `Public through ${readAccess.inheritedFrom ?? "a published parent folder"}.`
										: readAccess.source === "repository"
											? "Public because the repository is public."
											: `This ${publicationLabel} is published.`}
						</span>
					</div>

					{isPublished ? (
						<div className="flex min-w-0 items-stretch gap-2 max-[420px]:flex-col">
							<div
								className="flex h-9 min-w-0 grow cursor-text select-all items-center overflow-hidden rounded-lg border border-border-panel bg-bg-panel px-3 font-mono text-[11px] text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
								tabIndex={0}
								role="textbox"
								aria-readonly="true"
								aria-label={`Public link: ${canonicalUrl}`}
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

					<p
						className="text-xs leading-5 text-text-tertiary"
						aria-live="polite"
					>
						{errorMessage ? (
							<span className="text-error-700" role="alert">
								{errorMessage}
							</span>
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
							className="w-fit text-xs font-semibold text-text-secondary underline decoration-border-strong underline-offset-4 hover:text-text-primary disabled:opacity-50"
						>
							{busy === "unpublish" ? "Updating…" : unpublishLabel}
						</button>
					) : null}

					{onOpenTeam ? (
						<button
							type="button"
							onClick={onOpenTeam}
							className="-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
						>
							<Users
								className="size-3.5 shrink-0 text-text-tertiary"
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
