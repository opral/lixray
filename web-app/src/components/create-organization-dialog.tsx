import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { useRepository } from "~/components/repository-provider";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { formatCaughtError } from "~/lib/format";

/**
 * Mirrors the server's handle derivation (private.url_segment): lowercase,
 * non-alphanumerics collapse to single hyphens, trimmed, capped at 39 chars.
 * Conflicts get a unique suffix server-side, so this is a preview, not a
 * promise.
 */
export function organizationHandlePreview(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 39);
}

/**
 * "Create an organization" dialog (a shared namespace teammates join).
 * On success the provider refreshes and selects the new organization;
 * `onCreated` receives its id so hosts can chain (e.g. preselect it in the
 * repository dialog).
 */
export function CreateOrganizationDialog({
	open,
	onClose,
	onCreated,
}: {
	open: boolean;
	onClose: () => void;
	onCreated?: (organizationId: string) => void;
}) {
	const { createOrganization } = useRepository();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setName("");
		setError(null);
		setBusy(false);
	}, [open]);

	const handlePreview = organizationHandlePreview(name);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const organizationId = await createOrganization(name);
			toast.success(`Created “${name.trim()}”`);
			onClose();
			onCreated?.(organizationId);
		} catch (caught) {
			setError(formatCaughtError(caught));
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="border-border bg-panel shadow-lg">
				<form className="grid gap-5" onSubmit={(event) => void submit(event)}>
					<DialogHeader>
						<DialogTitle>Create an organization</DialogTitle>
						<DialogDescription>
							A shared home for your company’s repositories. You’ll be the
							owner.
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2">
						<label className="grid gap-2">
							<span className="text-[13px] font-semibold text-fg-muted">
								Organization name
							</span>
							<input
								className="h-10 w-full rounded-lg border border-border bg-panel px-[11px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
								autoFocus
								maxLength={80}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</label>
						<p
							className="m-0 min-h-[18px] text-[12.5px] text-fg-subtle"
							data-testid="organization-handle-preview"
						>
							{handlePreview ? (
								<>
									Your organization lives at{" "}
									<code className="rounded bg-bg-hover px-1.5 py-0.5 text-[11.5px]">
										lixray.com/@{handlePreview}
									</code>
								</>
							) : null}
						</p>
						{error ? (
							<p
								className="m-0 rounded-lg bg-danger-subtle px-3 py-2.5 text-[13px] text-danger-border"
								role="alert"
							>
								{error}
							</p>
						) : null}
					</div>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="featured"
							className="font-bold"
							disabled={busy || !name.trim()}
							data-testid="create-organization-submit"
						>
							{busy ? "Creating…" : "Create organization"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
