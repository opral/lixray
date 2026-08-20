import { fileIconUrl } from "@opral/atelier/file-icons";
import { Download, Folder, LockOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";

export type PublishedResource = {
	kind: "file" | "directory";
	path: string;
};

type PublishedResourceViewProps = {
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
 * Private path publications intentionally do not boot Atelier: doing so would
 * give its general SQL client more repository data than the published path.
 * This view uses the two narrow, read-only surfaces exposed by the worker.
 */
export function PublishedResourceView({
	namespace,
	repositorySlug,
	repositoryName,
	resource,
}: PublishedResourceViewProps) {
	return (
		<main className="min-h-screen bg-bg-panel font-sans text-text-primary">
			<header className="flex h-[82px] items-center gap-3 border-b border-border-panel px-6">
				<a
					href={`/@${namespace}/${repositorySlug}`}
					className="truncate text-[18px] font-semibold hover:underline"
				>
					{repositoryName}
				</a>
				<span className="text-text-quaternary">/</span>
				<span className="min-w-0 truncate text-[15px] text-text-secondary">
					{resource.path.split("/").filter(Boolean).at(-1)}
				</span>
				<span className="flex-1" />
				<span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border-panel px-3 py-1.5 text-[12px] font-medium text-text-tertiary">
					<LockOpen className="size-3.5" aria-hidden />
					Public · read-only
				</span>
			</header>
			{resource.kind === "directory" ? (
				<PublishedDirectory
					namespace={namespace}
					repositorySlug={repositorySlug}
					resource={resource}
				/>
			) : (
				<PublishedFile
					namespace={namespace}
					repositorySlug={repositorySlug}
					resource={resource}
				/>
			)}
		</main>
	);
}

function PublishedDirectory({
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
		void fetchPublishedDirectory(
			namespace,
			repositorySlug,
			resource.path,
			abort.signal,
		)
			.then(setListing)
			.catch((caught: unknown) => {
				if (abort.signal.aborted) return;
				setError(
					caught instanceof Error
						? caught.message
						: "Unable to open this directory.",
				);
			});
		return () => abort.abort();
	}, [namespace, repositorySlug, resource.path]);

	return (
		<section className="mx-auto w-[min(760px,calc(100%-48px))] py-10">
			<h1 className="mb-6 text-[20px] font-semibold">
				{resource.path.split("/").filter(Boolean).at(-1)}
			</h1>
			{error ? <PublishedError>{error}</PublishedError> : null}
			{!error && !listing ? (
				<p className="text-[13px] text-text-tertiary">Opening directory…</p>
			) : null}
			{listing?.entries.length === 0 ? (
				<div className="rounded-[10px] border border-dashed border-border-panel px-6 py-12 text-center text-[13px] text-text-tertiary">
					This directory is empty.
				</div>
			) : null}
			<div className="flex flex-col gap-px">
				{listing?.entries.map((entry) => (
					<a
						key={`${entry.kind}:${entry.path}`}
						href={publishedResourceHref(namespace, repositorySlug, entry)}
						className="flex min-h-11 items-center gap-3 rounded-[9px] px-3 text-[14px] transition-colors hover:bg-bg-raised"
					>
						{entry.kind === "directory" ? (
							<Folder className="size-[19px] fill-blue-400 text-blue-500" />
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
				<p className="mt-4 text-[12px] text-text-tertiary">
					Showing the first 1,000 items.
				</p>
			) : null}
		</section>
	);
}

function PublishedFile({
	namespace,
	repositorySlug,
	resource,
}: Omit<PublishedResourceViewProps, "repositoryName">) {
	const [bytes, setBytes] = useState<Uint8Array | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mimeType = mimeTypeForPath(resource.path);
	const objectUrl = useMemo(() => {
		if (!bytes) return null;
		return URL.createObjectURL(
			new Blob([new Uint8Array(bytes)], { type: mimeType }),
		);
	}, [bytes, mimeType]);

	useEffect(
		() => () => {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		},
		[objectUrl],
	);

	useEffect(() => {
		const abort = new AbortController();
		setBytes(null);
		setError(null);
		void fetchPublishedFile(
			namespace,
			repositorySlug,
			resource.path,
			abort.signal,
		)
			.then(setBytes)
			.catch((caught: unknown) => {
				if (abort.signal.aborted) return;
				setError(
					caught instanceof Error
						? caught.message
						: "Unable to open this file.",
				);
			});
		return () => abort.abort();
	}, [namespace, repositorySlug, resource.path]);

	const text = useMemo(
		() =>
			bytes && isTextPath(resource.path)
				? new TextDecoder().decode(bytes)
				: null,
		[bytes, resource.path],
	);

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
			{!error && !bytes ? (
				<p className="text-[13px] text-text-tertiary">Opening file…</p>
			) : null}
			{text !== null ? (
				<pre className="overflow-auto rounded-xl border border-border-panel bg-bg-raised p-5 font-mono text-[13px] leading-6 whitespace-pre-wrap">
					{text}
				</pre>
			) : null}
			{objectUrl && mimeType.startsWith("image/") ? (
				<img
					src={objectUrl}
					alt={fileName(resource.path)}
					className="max-h-[calc(100vh-190px)] max-w-full self-center rounded-xl object-contain"
				/>
			) : null}
			{objectUrl && mimeType === "application/pdf" ? (
				<iframe
					title={fileName(resource.path)}
					src={objectUrl}
					className="h-[calc(100vh-190px)] w-full rounded-xl border border-border-panel"
				/>
			) : null}
			{bytes &&
			text === null &&
			!mimeType.startsWith("image/") &&
			mimeType !== "application/pdf" ? (
				<div className="rounded-xl border border-dashed border-border-panel px-6 py-16 text-center text-[13px] text-text-tertiary">
					Preview is not available for this file type. Use Download to open it.
				</div>
			) : null}
		</section>
	);
}

function PublishedError({ children }: { children: string }) {
	return (
		<p className="rounded-lg bg-error-700/10 px-3 py-2 text-[13px] text-error-700">
			{children}
		</p>
	);
}

async function fetchPublishedDirectory(
	namespace: string,
	repositorySlug: string,
	path: string,
	signal: AbortSignal,
): Promise<PublishedDirectoryResponse> {
	const url = new URL(
		protocolUrl(namespace, repositorySlug, "published-directory"),
	);
	url.searchParams.set("path", path);
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error("This directory is no longer public.");
	return (await response.json()) as PublishedDirectoryResponse;
}

async function fetchPublishedFile(
	namespace: string,
	repositorySlug: string,
	path: string,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const baseUrl = protocolUrl(namespace, repositorySlug, "");
	const publicHeaders = { "X-Lixray-Public-Path": path };
	const handshake = await fetch(baseUrl, { headers: publicHeaders, signal });
	if (!handshake.ok) throw new Error("This file is no longer public.");
	const payload = (await handshake.json()) as { sessionId?: unknown };
	if (typeof payload.sessionId !== "string") {
		throw new Error("Unable to open this file.");
	}
	const sessionHeaders = {
		...publicHeaders,
		"Lix-Session-Id": payload.sessionId,
	};
	try {
		const fileUrl = new URL(protocolUrl(namespace, repositorySlug, "file"));
		fileUrl.searchParams.set("path", path);
		const response = await fetch(fileUrl, { headers: sessionHeaders, signal });
		if (!response.ok || response.headers.get("lix-file-found") === "false") {
			throw new Error("This file could not be found.");
		}
		return new Uint8Array(await response.arrayBuffer());
	} finally {
		void fetch(protocolUrl(namespace, repositorySlug, "session"), {
			method: "DELETE",
			headers: sessionHeaders,
		}).catch(() => undefined);
	}
}

function protocolUrl(
	namespace: string,
	repositorySlug: string,
	endpoint: string,
): string {
	return `${window.location.origin}/@${namespace}/${repositorySlug}/lix/v1/${endpoint}`;
}

function publishedResourceHref(
	namespace: string,
	repositorySlug: string,
	resource: PublishedResource,
): string {
	const kind = resource.kind === "directory" ? "dir" : "file";
	const encodedPath = resource.path
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
	return `/@${namespace}/${repositorySlug}/${kind}/${encodedPath}`;
}

function fileName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

function isTextPath(path: string): boolean {
	return /\.(?:cedar|cedarschema|csv|css|html?|ini|js|json|jsx|log|md|mjs|sql|svg|toml|ts|tsx|txt|xml|ya?ml)$/i.test(
		path,
	);
}

function mimeTypeForPath(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return (
		(
			{
				gif: "image/gif",
				jpeg: "image/jpeg",
				jpg: "image/jpeg",
				pdf: "application/pdf",
				png: "image/png",
				svg: "image/svg+xml",
				webp: "image/webp",
			} satisfies Record<string, string>
		)[extension ?? ""] ??
		(isTextPath(path) ? "text/plain" : "application/octet-stream")
	);
}
