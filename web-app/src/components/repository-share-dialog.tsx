import { fileIconUrl } from "@opral/atelier/file-icons";
import {
	Check,
	CircleAlert,
	Copy,
	Globe2,
	LockKeyhole,
	MessageSquare,
	Users,
} from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type CopyState = "idle" | "copied" | "failed";

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
	 * a conversation cannot, so its read access follows the repository. The
	 * link is copyable either way: unpublished, it opens for members only.
	 */
	publicationLabel: "file" | "folder" | "conversation" | "repository";
	readAccess: ReadShareAccess | null;
	/** An optional composed trigger owned by the surrounding shell. */
	trigger?: ReactElement;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** `unknown` when the link was copied before its access finished loading. */
	onCopied?: (url: string, mode: "public" | "members" | "unknown") => void;
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
	const linkRef = useRef<HTMLSpanElement>(null);
	const copyButtonRef = useRef<HTMLButtonElement>(null);
	const isPublished = readAccess?.status === "published";
	const documentIconUrl = fileIconUrl(documentName);

	// Access loads after the popover opens; a link copied meanwhile stays
	// copied, and the note below it names the audience once access is known.
	useEffect(() => {
		setCopyState("idle");
		setErrorMessage(null);
	}, [canonicalUrl, open]);

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
			await copyText(canonicalUrl);
		} catch {
			if (linkRef.current) selectLinkText(linkRef.current);
			setCopyState("failed");
			setErrorMessage(
				"Couldn’t copy. The link is selected, so copy it manually.",
			);
			return;
		}

		setErrorMessage(null);
		setCopyState("copied");
		onCopied?.(
			canonicalUrl,
			readAccess === null ? "unknown" : isPublished ? "public" : "members",
		);
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
					? `Couldn’t publish this ${publicationLabel}. Try again.`
					: `Couldn’t unpublish this ${publicationLabel}. Try again.`,
			);
		} finally {
			setBusy(null);
			// The clicked access button disables or unmounts; keep keyboard
			// focus inside the popover, on the action that follows.
			copyButtonRef.current?.focus();
		}
	};

	const copiedNote =
		readAccess === null
			? "Copied."
			: isPublished
				? `Copied. Anyone with this link can read this ${publicationLabel}.`
				: "Copied. Only repository members can open this link.";

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
						"z-50 grid w-[min(384px,calc(100vw-2rem))] grid-cols-[minmax(0,1fr)] gap-3.5 rounded-xl border border-border bg-panel p-[18px] text-fg shadow-[0_18px_50px_color-mix(in_srgb,var(--atelier-overlay)_18%,transparent),0_2px_8px_color-mix(in_srgb,var(--atelier-overlay)_8%,transparent)] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
						className,
					)}
				>
					<div className="flex min-w-0 items-center gap-2.5">
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

					<div className="flex min-w-0 items-stretch gap-2 max-[420px]:flex-col">
						<div
							className={cn(
								"flex h-9 min-w-0 grow cursor-text select-all items-center overflow-hidden rounded-lg border bg-panel px-3 font-mono text-[11px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
								copyState === "failed"
									? "border-danger-border"
									: "border-border",
							)}
							tabIndex={0}
							role="textbox"
							aria-readonly="true"
							aria-label={`${
								readAccess === null
									? "Link"
									: isPublished
										? "Public link"
										: "Members-only link"
							}: ${canonicalUrl}`}
							title={canonicalUrl}
							onClick={() => linkRef.current && selectLinkText(linkRef.current)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									if (linkRef.current) selectLinkText(linkRef.current);
								}
							}}
						>
							<span ref={linkRef} className="block truncate">
								{canonicalUrl}
							</span>
						</div>
						<Button
							ref={copyButtonRef}
							type="button"
							variant="featured"
							onClick={() => void handleCopy()}
							className="w-[118px] shrink-0 font-semibold max-[420px]:w-full"
						>
							{copyState === "copied" ? (
								<Check aria-hidden="true" />
							) : (
								<Copy aria-hidden="true" />
							)}
							{copyState === "copied" ? "Copied" : "Copy link"}
						</Button>
					</div>

					{/* Always mounted, so screen readers announce what fills it; out of the grid while empty. */}
					<div aria-live="polite" className="-mt-1 empty:absolute">
						{errorMessage ? (
							<p
								className="flex gap-1.5 text-xs leading-5 text-danger"
								role="alert"
							>
								<CircleAlert
									className="mt-[3px] size-3.5 shrink-0"
									aria-hidden="true"
								/>
								{errorMessage}
							</p>
						) : copyState === "copied" ? (
							<p className="flex gap-1.5 text-xs leading-5 text-diff-added">
								<Check
									className="mt-[3px] size-3.5 shrink-0"
									aria-hidden="true"
								/>
								{copiedNote}
							</p>
						) : null}
					</div>

					<ShareAccessRow
						readAccess={readAccess}
						publicationLabel={publicationLabel}
						busy={busy}
						onPublish={() =>
							void runPermissionChange("publish", publishReadLink)
						}
						onUnpublish={() =>
							void runPermissionChange("unpublish", unpublishReadLink)
						}
					/>

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

/**
 * Who can open the link, and the one change the viewer may make to that.
 * Publishing widens the audience of the same URL; it never mints a new link.
 */
function ShareAccessRow({
	readAccess,
	publicationLabel,
	busy,
	onPublish,
	onUnpublish,
}: {
	readAccess: ReadShareAccess | null;
	publicationLabel: RepositoryShareDialogProps["publicationLabel"];
	busy: "publish" | "unpublish" | null;
	onPublish: () => void;
	onUnpublish: () => void;
}) {
	const isRepository = publicationLabel === "repository";
	let title: string;
	let detail: string;
	let action: ReactElement | null = null;

	if (readAccess === null) {
		title = "Checking who can open it…";
		detail = "";
	} else if (readAccess.status === "private") {
		title = "Only repository members";
		if (publicationLabel === "conversation") {
			detail = "A conversation follows the repository’s access.";
		} else if (busy === "publish") {
			detail = "Publishing…";
		} else if (!readAccess.canPublish) {
			detail = isRepository
				? "Only a repository admin can make it public."
				: "Only a repository admin can publish it.";
		} else if (publicationLabel === "folder") {
			detail = "Publish to let anyone read this folder and everything in it.";
		} else if (isRepository) {
			detail = "Make it public so anyone can read it. Only members can edit.";
		} else {
			detail = "People outside need an invite to open it.";
		}
		if (publicationLabel !== "conversation" && readAccess.canPublish) {
			action = (
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy !== null}
					onClick={onPublish}
					className="h-[30px] px-3 text-xs"
				>
					{busy === "publish"
						? "Publishing…"
						: isRepository
							? "Make public"
							: "Publish"}
				</Button>
			);
		}
	} else {
		title = "Anyone with the link can read";
		detail =
			readAccess.source === "ancestor"
				? `Published through ${readAccess.inheritedFrom ?? "a parent folder"}. Unpublish it there.`
				: readAccess.source === "repository" && !isRepository
					? "Because the repository is public."
					: "Only members can edit.";
		if (readAccess.canUnpublish) {
			action = (
				<button
					type="button"
					disabled={busy !== null}
					onClick={onUnpublish}
					className="h-[30px] shrink-0 rounded-md px-1 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring text-fg-muted underline decoration-border-strong underline-offset-4 hover:text-fg disabled:opacity-50"
				>
					{busy === "unpublish"
						? "Updating…"
						: isRepository
							? "Make private"
							: "Unpublish"}
				</button>
			);
		}
	}

	const isPublished = readAccess?.status === "published";
	return (
		<div className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-bg-hover p-2.5">
			<div
				className={cn(
					"flex size-[30px] shrink-0 items-center justify-center rounded-full border border-border",
					readAccess === null
						? "border-transparent bg-border"
						: isPublished
							? "bg-success-subtle text-diff-added"
							: "bg-panel text-fg-subtle",
				)}
			>
				{readAccess === null ? null : isPublished ? (
					<Globe2 className="size-[15px]" aria-hidden="true" />
				) : (
					<LockKeyhole className="size-[15px]" aria-hidden="true" />
				)}
			</div>
			<div
				className={cn(
					"flex min-w-0 grow flex-col",
					readAccess === null ? "gap-[7px]" : "gap-px",
				)}
			>
				<span
					className={cn(
						"text-[13px] leading-[18px] font-semibold",
						readAccess === null ? "text-fg-subtle" : "text-fg",
					)}
				>
					{title}
				</span>
				{readAccess === null ? (
					<span className="h-[9px] w-[150px] max-w-full rounded bg-border" />
				) : null}
				{detail ? (
					<span className="text-xs leading-[17px] text-fg-subtle">
						{detail}
					</span>
				) : null}
			</div>
			{action}
		</div>
	);
}
