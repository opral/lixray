import { Trash2 } from "lucide-react";
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

/** An OAuth client the account has granted, with what LixRay saw it do. */
export type ConnectedApp = {
	readonly clientId: string;
	readonly name: string;
	readonly uri: string | null;
	readonly scopes: readonly string[];
	readonly grantedAt: string;
	/** Present once the client has called a tool against a repository. */
	readonly use: {
		readonly repositoryCount: number;
		readonly lastTool: string;
		readonly lastSeenAt: string;
	} | null;
};

export interface ConnectedAppsApi {
	listConnectedApps(): Promise<ConnectedApp[]>;
	/** Revokes the grant and forgets LixRay's record of the client. */
	revokeConnectedApp(clientId: string): Promise<void>;
}

/**
 * The MCP clients that can act as this account. Revoking ends the grant:
 * the client's sessions are deleted and its refresh tokens rejected; an
 * access token it already holds expires on its own within the hour.
 */
export function ConnectedAppsPanel({ api }: { api: ConnectedAppsApi }) {
	const [apps, setApps] = useState<ConnectedApp[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [revoking, setRevoking] = useState<ConnectedApp | null>(null);
	const [reload, setReload] = useState(0);
	useEffect(() => {
		let disposed = false;
		setLoading(true);
		setError(null);
		void Promise.resolve()
			.then(() => api.listConnectedApps())
			.then((items) => {
				if (!disposed) setApps(items);
			})
			.catch(() => {
				if (!disposed)
					setError("Couldn’t load your connected apps. Please try again.");
			})
			.finally(() => {
				if (!disposed) setLoading(false);
			});
		return () => {
			disposed = true;
		};
	}, [api, reload]);
	async function revoke() {
		if (!revoking) return;
		setBusy(true);
		setError(null);
		try {
			await api.revokeConnectedApp(revoking.clientId);
			setApps((current) =>
				current.filter((app) => app.clientId !== revoking.clientId),
			);
			toast.success(`Disconnected ${revoking.name}`);
		} catch {
			setError(
				"Couldn’t confirm the disconnect. Reload to check your connected apps, then try again.",
			);
		} finally {
			setBusy(false);
			setRevoking(null);
		}
	}
	return (
		<>
			<section
				aria-label="Connected apps"
				className="mb-3.5 rounded-xl border border-border-panel bg-bg-panel px-[18px] py-4"
			>
				<div className="mb-3">
					<h2 className="m-0 text-[13.5px] font-bold">Connected apps</h2>
					<p className="m-0 mt-0.5 text-xs text-text-tertiary">
						MCP clients you have allowed to act as you.
					</p>
				</div>
				<p className="text-xs leading-relaxed text-text-tertiary">
					Each app can read and write every repository your account can.
					Disconnecting ends its access; a token it already holds expires within
					the hour.
				</p>
				{loading ? (
					<p role="status" className="mt-4 text-sm text-text-tertiary">
						Loading connected apps…
					</p>
				) : apps.length ? (
					<ul className="m-0 mt-4 list-none p-0">
						{apps.map((app) => (
							<li
								key={app.clientId}
								aria-label={app.name}
								className="flex items-center gap-3 border-t border-border-subtle py-3"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="break-words text-[13px] font-semibold">
											{app.name}
										</span>
										{app.uri ? (
											<span className="truncate text-xs text-text-tertiary">
												{app.uri}
											</span>
										) : null}
									</div>
									<p className="m-0 mt-1 text-xs leading-relaxed text-text-tertiary">
										Connected{" "}
										<time
											dateTime={app.grantedAt}
											title={new Date(app.grantedAt).toLocaleString()}
										>
											{formatDate(app.grantedAt)}
										</time>
										{app.use ? (
											<>
												<span className="mx-1.5">·</span>
												Last used{" "}
												<time
													dateTime={app.use.lastSeenAt}
													title={new Date(app.use.lastSeenAt).toLocaleString()}
												>
													{formatDate(app.use.lastSeenAt)}
												</time>{" "}
												({app.use.lastTool}) in{" "}
												{app.use.repositoryCount === 1
													? "1 repository"
													: `${app.use.repositoryCount} repositories`}
											</>
										) : (
											<>
												<span className="mx-1.5">·</span>Not used yet
											</>
										)}
									</p>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="text-xs text-text-tertiary hover:text-error-700"
									aria-label={`Disconnect ${app.name}`}
									disabled={busy}
									onClick={() => setRevoking(app)}
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
									Disconnect
								</Button>
							</li>
						))}
					</ul>
				) : !error ? (
					<p className="mt-4 text-sm text-text-tertiary">
						No app is connected. Add LixRay as an MCP server in your client and
						it will appear here after you allow it.
					</p>
				) : null}
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
			</section>
			<Dialog
				open={!!revoking}
				onOpenChange={(open) => {
					if (!open && !busy) setRevoking(null);
				}}
			>
				<DialogContent showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>Disconnect {revoking?.name}?</DialogTitle>
						<DialogDescription>
							The app’s sessions end now and it cannot refresh. A token it
							already holds expires within the hour. Connect it again from the
							app to grant access anew.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setRevoking(null)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() => void revoke()}
						>
							{busy ? "Disconnecting…" : "Disconnect"}
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
