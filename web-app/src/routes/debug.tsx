import { openLix, type Lix } from "@lix-js/sdk";
import "@opral/atelier/style.css";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import { AccountMenu } from "~/components/account-menu";
import { Button } from "~/components/ui/button";

// Load browser editors only after a snapshot is selected, never during SSR.
const SnapshotAtelier = lazy(async () => {
	const { Atelier } = await import("@opral/atelier");
	return { default: Atelier };
});

export const Route = createFileRoute("/debug")({
	head: () => ({
		meta: [
			{ title: "Developer tools · LixRay" },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: DebugPage,
});

function DebugPage() {
	const picker = useRef<HTMLInputElement>(null);
	const [ready, setReady] = useState(false);
	useEffect(() => setReady(true), []);
	const [file, setFile] = useState<File | null>(null);
	return (
		<div className="ph-no-capture flex h-dvh flex-col overflow-hidden bg-bg text-fg">
			{file ? (
				<SnapshotSession file={file} onClose={() => setFile(null)} />
			) : (
				<>
					<AppTitlebar>
						<AppTitlebarBrand href="/" />
						<AccountMenu className="ml-auto" />
					</AppTitlebar>
					<main className="flex w-full max-w-2xl flex-col items-start gap-4 overflow-auto px-[18px] py-8 max-[560px]:px-3">
						<Link
							to="/home"
							className="rounded text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
						>
							← Repositories
						</Link>
						<h1 className="text-xl font-semibold">
							Open lix repository from snapshot
						</h1>
						<p className="text-sm text-fg-muted">
							Opens in memory. Nothing is uploaded or saved. Closing or
							refreshing discards the session.
						</p>
						<input
							ref={picker}
							className="hidden"
							aria-label="Snapshot file"
							disabled={!ready}
							type="file"
							accept=".lixsnap,.snapshot,application/vnd.lix.snapshot"
							onChange={(event) => {
								const selected = event.currentTarget.files?.[0];
								if (selected) setFile(selected);
							}}
						/>
						<Button
							variant="secondary"
							disabled={!ready}
							onClick={() => picker.current?.click()}
						>
							Open snapshot…
						</Button>
					</main>
				</>
			)}
		</div>
	);
}

function SnapshotSession({
	file,
	onClose,
}: {
	file: File;
	onClose: () => void;
}) {
	const [lix, setLix] = useState<Lix | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		let opened: Lix | undefined;
		// Omitting storage and server is deliberate: snapshots must never enter
		// the hosted repository session manager or its persistent browser replica.
		void openLix
			.fromSnapshot(file.stream())
			.then(async (repository) => {
				if (disposed) {
					await repository.close();
					return;
				}
				opened = repository;
				setLix(repository);
			})
			.catch((caught: unknown) => {
				if (!disposed)
					setError(
						caught instanceof Error
							? caught.message
							: "Unable to read this snapshot.",
					);
			});
		return () => {
			disposed = true;
			void opened?.close().catch(() => undefined);
		};
	}, [file]);

	const navbarBrand = (
		<Link
			to="/home"
			aria-label="LixRay home"
			className="-ml-1.5 inline-flex shrink-0 items-center rounded-[5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
		>
			<img className="size-6" src="/lixray-mark.svg" alt="" />
		</Link>
	);
	const closeButton = (
		<Button variant="secondary" size="sm" onClick={onClose}>
			Close snapshot
		</Button>
	);
	return (
		<>
			{lix ? (
				<div className="relative flex min-h-0 flex-1 flex-col">
					<div
						className="shrink-0 truncate px-3.5 py-1 text-xs text-fg-subtle"
						title={file.name}
					>
						{file.name} · <span>In memory · discarded on close or refresh</span>
					</div>
					{/* Atelier's default session, preference, and review stores are all in memory. */}
					<div className="min-h-0 flex-1">
						<Suspense
							fallback={
								<p role="status" className="p-6 text-sm text-fg-muted">
									Opening repository UI…
								</p>
							}
						>
							<SnapshotAtelier
								lix={lix}
								topBarProps={{
									"data-app-titlebar": true,
									className: "border-b border-border-subtle bg-bg",
								}}
								slots={{ navbarBrand, navbarEnd: closeButton }}
							/>
						</Suspense>
					</div>
				</div>
			) : (
				<>
					<AppTitlebar>
						{navbarBrand}
						<div className="ml-auto">{closeButton}</div>
					</AppTitlebar>
					<main className="grid flex-1 place-content-center gap-3 p-6 text-center">
						{error ? (
							<div role="alert" className="max-w-xl break-words">
								<h1 className="font-semibold">Unable to open snapshot</h1>
								<p className="mt-2 text-sm text-fg-muted">{error}</p>
								<Button className="mt-4" variant="secondary" onClick={onClose}>
									Choose another snapshot
								</Button>
							</div>
						) : (
							<p role="status">Opening snapshot…</p>
						)}
					</main>
				</>
			)}
		</>
	);
}
