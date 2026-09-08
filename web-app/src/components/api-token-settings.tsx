import { Copy, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";

type TokenMetadata = {
	id: string;
	name: string;
	created_at: string;
	expires_at: string;
};
export interface RepositoryApiTokenApi {
	listApiTokens(): Promise<TokenMetadata[]>;
	generateApiToken(): Promise<TokenMetadata & { token: string }>;
	deleteApiToken(tokenId: string): Promise<void>;
}

export function RepositoryApiTokenPanel({
	api,
}: {
	api: RepositoryApiTokenApi;
}) {
	const [tokens, setTokens] = useState<TokenMetadata[]>([]);
	const [created, setCreated] = useState<
		(TokenMetadata & { token: string }) | null
	>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<TokenMetadata | null>(null);
	const [reload, setReload] = useState(0);
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => {
		let disposed = false;
		setLoading(true);
		setError(null);
		void Promise.resolve()
			.then(() => api.listApiTokens())
			.then((items) => {
				if (!disposed) setTokens(items);
			})
			.catch(() => {
				if (!disposed)
					setError("Couldn’t load your API tokens. Please try again.");
			})
			.finally(() => {
				if (!disposed) setLoading(false);
			});
		return () => {
			disposed = true;
		};
	}, [api, reload]);
	async function generate() {
		setBusy(true);
		setError(null);
		try {
			const result = await api.generateApiToken();
			const { token: secret, ...metadata } = result;
			setTokens((current) => [metadata, ...current]);
			setCreated({ ...metadata, token: secret });
		} catch {
			setError(
				"Couldn’t retrieve the new token. Reload to check whether it was created, then delete it if you didn’t receive its secret.",
			);
		} finally {
			setBusy(false);
		}
	}
	async function remove() {
		if (!deleting) return;
		setBusy(true);
		setError(null);
		try {
			await api.deleteApiToken(deleting.id);
			setTokens((current) =>
				current.filter((token) => token.id !== deleting.id),
			);
			if (created?.id === deleting.id) setCreated(null);
			toast.success(`Deleted ${deleting.name}`);
		} catch {
			setError(
				"Couldn’t confirm deletion. Reload to check your tokens, then try again.",
			);
		} finally {
			setBusy(false);
			setDeleting(null);
		}
	}
	return (
		<>
			<section
				aria-label="API tokens"
				className="mb-3.5 rounded-xl border border-border-panel bg-bg-panel px-[18px] py-4"
			>
				<div className="mb-3 flex flex-wrap items-center gap-3">
					<div className="min-w-0 flex-1 basis-[220px]">
						<h2 className="m-0 text-[13.5px] font-bold">API tokens</h2>
						<p className="m-0 mt-0.5 text-xs text-text-tertiary">
							Your personal tokens for this repository.
						</p>
					</div>
					<Button
						variant="ghost"
						className="text-xs text-text-secondary"
						size="sm"
						disabled={loading || busy || !!error || !!created}
						onClick={() => void generate()}
					>
						<Plus className="size-3.5" aria-hidden="true" />
						{busy && !deleting ? "Generating…" : "Generate token"}
					</Button>
				</div>
				<p className="text-xs leading-relaxed text-text-tertiary">
					Each token can read and write only this repository. Tokens expire
					after one year and require you to remain a member.
				</p>
				{loading ? (
					<p role="status" className="mt-4 text-sm text-text-tertiary">
						Loading tokens…
					</p>
				) : (
					<>
						{created ? (
							<div
								className="ph-no-capture my-4 rounded-lg border border-border-panel bg-bg-app p-4"
								data-ph-no-capture
							>
								<p className="m-0 mb-1 break-words text-[13px] font-semibold">
									{created.name}
								</p>
								<p className="m-0 mb-3 text-xs text-text-secondary">
									Copy this token now. You won’t be able to see it again.
								</p>
								<label htmlFor="api-token-secret" className="sr-only">
									New API token
								</label>
								<textarea
									id="api-token-secret"
									readOnly
									value={created.token}
									rows={3}
									spellCheck={false}
									className="ph-no-capture w-full resize-none break-all rounded-md border border-border-panel bg-bg-panel p-3 font-mono text-xs"
								/>
								<div className="mt-3 flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() =>
											void navigator.clipboard.writeText(created.token).then(
												() => toast.success("Token copied"),
												() =>
													toast.error(
														"Couldn’t copy. Select and copy the token above.",
													),
											)
										}
									>
										<Copy className="size-3.5" aria-hidden="true" />
										Copy token
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setCreated(null)}
									>
										Done
									</Button>
								</div>
							</div>
						) : null}
						{tokens.length ? (
							<ul className="m-0 mt-4 list-none p-0">
								{tokens.map((token) => (
									<li
										key={token.id}
										aria-label={token.name}
										className="flex items-center gap-3 border-t border-border-subtle py-3"
									>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="break-words text-[13px] font-semibold">
													{token.name}
												</span>
												{Date.parse(token.expires_at) <= now ? (
													<span className="rounded bg-bg-hover-canvas px-1.5 py-0.5 text-[11px] text-text-secondary">
														Expired
													</span>
												) : null}
											</div>
											<p className="m-0 mt-1 text-xs leading-relaxed text-text-tertiary">
												Created{" "}
												<time
													dateTime={token.created_at}
													title={new Date(token.created_at).toLocaleString()}
												>
													{formatDate(token.created_at)}
												</time>
												<span className="mx-1.5">·</span>Expires{" "}
												<time dateTime={token.expires_at}>
													{formatDate(token.expires_at)}
												</time>
											</p>
										</div>
										<Button
											variant="ghost"
											size="sm"
											className="text-xs text-text-tertiary hover:text-error-700"
											aria-label={`Delete ${token.name}`}
											disabled={busy}
											onClick={() => setDeleting(token)}
										>
											<Trash2 className="size-3.5" aria-hidden="true" />
											Delete
										</Button>
									</li>
								))}
							</ul>
						) : !error ? (
							<p className="mt-4 text-sm text-text-tertiary">
								You haven’t generated any tokens for this repository yet.
							</p>
						) : null}
					</>
				)}
				{error ? (
					<div role="alert" className="my-4 text-sm text-error-700">
						<p>{error}</p>
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setReload((value) => value + 1)}
						>
							Reload
						</Button>
					</div>
				) : null}
				<a
					href="https://lix.dev/docs/hosting"
					target="_blank"
					rel="noopener noreferrer"
					className="mt-4 inline-block rounded-sm text-xs font-medium text-text-link underline-offset-4 hover:text-text-link-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring-focus-visible"
				>
					Get started using the API →
				</a>
			</section>
			<Dialog
				open={!!deleting}
				onOpenChange={(open) => {
					if (!open && !busy) setDeleting(null);
				}}
			>
				<DialogContent showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>Delete {deleting?.name}?</DialogTitle>
						<DialogDescription>
							Apps using this token will lose access immediately. Your other
							tokens will keep working.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setDeleting(null)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() => void remove()}
						>
							{busy ? "Deleting…" : "Delete token"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
function formatDate(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}
