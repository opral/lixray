import { entityRoutePath, resolvePublishedEntity } from "~/lib/entity-url";
import { AtelierFile } from "@opral/atelier";
import { fileIconUrl } from "@opral/atelier/file-icons";
import { openPublishedLix, publishedResponseError } from "~/lib/published-lix";
import type { Lix } from "@lix-js/sdk";
import { Download, Folder, LockOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";

export type PublishedResource = {
	id: string;
	kind: "file" | "directory";
	path: string;
};

type PublishedResourceViewProps = {
	repositoryId: string;
	namespace: string;
	repositorySlug: string;
	repositoryName: string;
	resource: PublishedResource;
};

type PublishedDirectoryEntry = PublishedResource;

type PublishedDirectoryResponse = {
	entries: PublishedDirectoryEntry[];
	truncated: boolean;
};

/**
 * Authorized downloads populate a local in-memory Lix. Atelier renders it
 * through the same file component used by the repository workspace.
 */
export function PublishedResourceView({
	repositoryId,
	namespace,
	repositorySlug,
	repositoryName,
	resource,
}: PublishedResourceViewProps) {
	return (
		<main className="min-h-screen bg-panel font-sans text-fg">
			<header className="flex h-[82px] items-center gap-3 border-b border-border px-6">
				<a
					href={`/@${namespace}/${repositorySlug}`}
					className="truncate text-[18px] font-semibold hover:underline"
				>
					{repositoryName}
				</a>
				<span className="text-fg-faint">/</span>
				<span className="min-w-0 truncate text-[15px] text-fg-muted">
					{resource.path.split("/").filter(Boolean).at(-1)}
				</span>
				<span className="flex-1" />
				<span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-fg-subtle">
					<LockOpen className="size-3.5" aria-hidden />
					Public · read-only
				</span>
			</header>
			{resource.kind === "directory" ? (
				<PublishedDirectory
					repositoryId={repositoryId}
					namespace={namespace}
					repositorySlug={repositorySlug}
					resource={resource}
				/>
			) : (
				<PublishedFile
					key={`${repositoryId}:${resource.path}`}
					repositoryId={repositoryId}
					namespace={namespace}
					repositorySlug={repositorySlug}
					resource={resource}
				/>
			)}
		</main>
	);
}

function PublishedDirectory({
	repositoryId,
	namespace,
	repositorySlug,
	resource,
}: Omit<PublishedResourceViewProps, "repositoryName">) {
	const [listing, setListing] = useState<PublishedDirectoryResponse | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const abort = new AbortController();
		setListing(null);
		setError(null);
		void fetchPublishedDirectory(repositoryId, resource.path, abort.signal)
			.then((next) => {
				if (!abort.signal.aborted) setListing(next);
			})
			.catch((caught: unknown) => {
				if (abort.signal.aborted) return;
				setError(
					caught instanceof Error
						? caught.message
						: "Unable to open this directory.",
				);
			});
		return () => abort.abort();
	}, [repositoryId, resource.path]);

	return (
		<section className="mx-auto w-[min(760px,calc(100%-48px))] py-10">
			<h1 className="mb-6 text-[20px] font-semibold">
				{resource.path.split("/").filter(Boolean).at(-1)}
			</h1>
			{error ? <PublishedError>{error}</PublishedError> : null}
			{!error && !listing ? (
				<p className="text-[13px] text-fg-subtle">Opening directory…</p>
			) : null}
			{listing?.entries.length === 0 ? (
				<div className="rounded-[10px] border border-dashed border-border px-6 py-12 text-center text-[13px] text-fg-subtle">
					This directory is empty.
				</div>
			) : null}
			<div className="flex flex-col gap-px">
				{listing?.entries.map((entry) => (
					<a
						key={`${entry.kind}:${entry.path}`}
						href={publishedResourceHref(namespace, repositorySlug, entry)}
						className="flex min-h-11 items-center gap-3 rounded-[9px] px-3 text-[14px] transition-colors hover:bg-panel"
					>
						{entry.kind === "directory" ? (
							<Folder className="size-[19px] fill-folder/60 text-folder" />
						) : (
							<img
								src={fileIconUrl(fileName(entry.path))}
								alt=""
								className="size-[19px]"
							/>
						)}
						<span className="truncate font-medium">{fileName(entry.path)}</span>
					</a>
				))}
			</div>
			{listing?.truncated ? (
				<p className="mt-4 text-[12px] text-fg-subtle">
					Showing the first 1,000 items.
				</p>
			) : null}
		</section>
	);
}

function PublishedFile(
	props: Omit<PublishedResourceViewProps, "repositoryName">,
) {
	const { repositoryId, namespace, repositorySlug, resource } = props;
	const [lix, setLix] = useState<Lix | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const abort = new AbortController();
		let owned: Lix | undefined;
		setLix(null);
		setError(null);
		void openPublishedLix({
			origin: window.location.origin,
			repositoryId,
			namespace,
			repositorySlug,
			fileId: resource.id,
			path: resource.path,
			signal: abort.signal,
		})
			.then(async (client) => {
				if (abort.signal.aborted) {
					await client.close();
					return;
				}
				owned = client;
				setLix(client);
			})
			.catch((caught: unknown) => {
				if (!abort.signal.aborted)
					setError(
						caught instanceof Error
							? caught.message
							: "Unable to load this public view.",
					);
			});
		return () => {
			abort.abort();
			void owned?.close().catch(() => undefined);
		};
	}, [repositoryId, namespace, repositorySlug, resource.id, resource.path]);
	if (error)
		return (
			<section className="mx-auto w-[min(960px,calc(100%-48px))] py-8">
				<PublishedError>{error}</PublishedError>
			</section>
		);
	if (!lix)
		return (
			<p className="mx-auto w-[min(960px,calc(100%-48px))] py-8 text-[13px] text-fg-subtle">
				Opening file…
			</p>
		);
	return <PublishedFileView {...props} lix={lix} fileId={resource.id} />;
}

/** Rendering owns no protocol requests or client lifetime. */
export function PublishedFileView({
	lix,
	fileId,
	repositoryId,
	namespace,
	repositorySlug,
	resource,
}: Omit<PublishedResourceViewProps, "repositoryName"> & {
	lix: Lix;
	fileId: string;
}) {
	const navigationAbort = useRef<AbortController | null>(null);
	useEffect(
		() => () => navigationAbort.current?.abort(),
		[repositoryId, resource.path],
	);
	const [bytes, setBytes] = useState<Uint8Array | null>(null);
	const [error, setError] = useState<string | null>(null);
	const objectUrl = useMemo(() => {
		if (!bytes) return null;
		return URL.createObjectURL(
			new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
		);
	}, [bytes]);

	useEffect(
		() => () => {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		},
		[objectUrl],
	);

	useEffect(() => {
		let active = true;
		setBytes(null);
		void lix
			.execute("SELECT content FROM lix_file WHERE id = $1", [fileId])
			.then((result) => {
				const content = result.rows[0]?.content;
				if (active && content instanceof Uint8Array) setBytes(content);
			})
			.catch((caught: unknown) => {
				if (active)
					setError(
						caught instanceof Error
							? caught.message
							: "Unable to prepare download.",
					);
			});
		return () => {
			active = false;
		};
	}, [lix, fileId]);

	return (
		<section className="mx-auto flex w-[min(960px,calc(100%-48px))] flex-col py-8">
			<div className="mb-5 flex items-center gap-3">
				<img
					src={fileIconUrl(fileName(resource.path))}
					alt=""
					className="size-5"
				/>
				<h1 className="min-w-0 truncate text-[18px] font-semibold">
					{fileName(resource.path)}
				</h1>
				<span className="flex-1" />
				{objectUrl ? (
					<Button asChild variant="outline" size="sm">
						<a href={objectUrl} download={fileName(resource.path)}>
							<Download className="size-4" />
							Download
						</a>
					</Button>
				) : null}
			</div>
			{error ? <PublishedError>{error}</PublishedError> : null}
			<AtelierFile
				lix={lix}
				fileId={fileId}
				readOnly
				className="min-h-[60vh]"
				onOpenFile={(path: string) => {
					navigationAbort.current?.abort();
					const abort = new AbortController();
					navigationAbort.current = abort;
					void resolvePublishedEntity({
						namespace,
						repository: repositorySlug,
						kind: "file",
						path,
						signal: abort.signal,
					})
						.then((entity) => {
							if (!entity) throw new Error("This file is no longer available.");
							if (!abort.signal.aborted && entity.lixId === repositoryId)
								window.location.assign(
									entityRoutePath(
										namespace,
										repositorySlug,
										"file",
										entity.id,
										entity.path,
									),
								);
						})
						.catch((caught: unknown) => {
							if (!abort.signal.aborted)
								setError(
									caught instanceof Error
										? caught.message
										: "Unable to open this file.",
								);
						});
				}}
				fallback={
					<p>
						Preview is not available for this file type. Use Download to open
						it.
					</p>
				}
			/>
		</section>
	);
}

function PublishedError({ children }: { children: string }) {
	return (
		<p className="rounded-lg bg-danger-border/10 px-3 py-2 text-[13px] text-danger-border">
			{children}
		</p>
	);
}

async function fetchPublishedDirectory(
	repositoryId: string,
	path: string,
	signal: AbortSignal,
): Promise<PublishedDirectoryResponse> {
	const url = new URL(
		`/api/published/lix/${encodeURIComponent(repositoryId)}/directory`,
		window.location.origin,
	);
	url.searchParams.set("path", path);
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(await publishedResponseError(response));
	return (await response.json()) as PublishedDirectoryResponse;
}

function publishedResourceHref(
	namespace: string,
	repositorySlug: string,
	resource: PublishedResource,
): string {
	return entityRoutePath(
		namespace,
		repositorySlug,
		resource.kind,
		resource.id,
		resource.path,
	);
}

function fileName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}
