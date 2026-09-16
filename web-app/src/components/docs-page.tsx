import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiteHeader } from "~/components/site-header";
import {
	type DocsEntry,
	docsEntries,
	docsMarkdown,
	docsToc,
} from "~/lib/docs-content";
import { renderDocsMarkdown } from "~/lib/docs-markdown";
import { cn } from "~/lib/utils";

export function DocsPage({ entry }: { entry: DocsEntry }) {
	const markdown = docsMarkdown(entry);
	const { html } = useMemo(() => renderDocsMarkdown(markdown), [markdown]);
	const index = docsEntries.findIndex((item) => item.slug === entry.slug);
	const previous = index > 0 ? docsEntries[index - 1] : undefined;
	const next =
		index < docsEntries.length - 1 ? docsEntries[index + 1] : undefined;

	return (
		<div className="flex min-h-screen flex-col bg-bg font-sans text-fg antialiased">
			<SiteHeader sticky />

			<div className="docs-layout">
				<nav className="docs-navigation" aria-label="Docs navigation">
					{Object.entries(docsToc).map(([group, items]) => (
						<div className="mb-[26px] flex flex-col gap-1.5" key={group}>
							<span className="pb-1 font-mono text-[11.5px] font-semibold tracking-[.07em] text-fg-faint uppercase">
								{group}
							</span>
							{items.map((item) => {
								const slug = item.path.replace(/\.md$/, "");
								const active = slug === entry.slug;
								return (
									<Link
										className={cn(
											"block py-[3px] text-sm text-fg-muted no-underline hover:text-fg",
											active && "font-semibold text-accent",
										)}
										key={item.path}
										to="/docs/$slug"
										params={{ slug }}
									>
										{item.label}
									</Link>
								);
							})}
						</div>
					))}
				</nav>

				<main className="docs-main">
					<div className="docs-content">
						<div className="mb-4 flex justify-end">
							<CopyMarkdownButton markdown={markdown} />
						</div>
						<DocsArticle html={html} />
						<div className="mt-14 flex items-center justify-between border-t border-fg/8 pt-6 text-sm">
							{previous ? (
								<PagerLink entry={previous} direction="previous" />
							) : (
								<span />
							)}
							{next ? <PagerLink entry={next} direction="next" /> : null}
						</div>
					</div>
				</main>
			</div>

			<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-fg/7 px-5 py-6 text-sm text-fg-subtle sm:px-14">
				<span className="inline-flex items-center gap-2">
					<img className="size-4" src="/lixray-mark.svg" alt="" />
					<span className="font-semibold text-fg-muted">LixRay</span>
				</span>
				<a
					className="no-underline hover:text-fg-muted"
					href="https://opral.com"
					target="_blank"
					rel="noreferrer"
				>
					© 2026 Opral
				</a>
				<nav className="flex flex-wrap items-center gap-4">
					<Link className="no-underline hover:text-fg-muted" to="/privacy">
						Privacy
					</Link>
					<Link className="no-underline hover:text-fg-muted" to="/terms">
						Terms
					</Link>
					<Link className="no-underline hover:text-fg-muted" to="/support">
						Support
					</Link>
					<a
						className="font-semibold text-fg-muted no-underline"
						href="https://github.com/opral"
						target="_blank"
						rel="noreferrer"
					>
						GitHub ↗
					</a>
				</nav>
			</footer>
		</div>
	);
}

function DocsArticle({ html }: { html: string }) {
	const articleRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const article = articleRef.current;
		if (!article) return;
		const cleanups: (() => void)[] = [];
		for (const pre of article.querySelectorAll("pre")) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "copy";
			button.textContent = "Copy";
			const onClick = () => {
				void navigator.clipboard.writeText(
					pre.querySelector("code")?.textContent ?? "",
				);
				button.textContent = "Copied";
				setTimeout(() => {
					button.textContent = "Copy";
				}, 1500);
			};
			button.addEventListener("click", onClick);
			pre.appendChild(button);
			cleanups.push(() => {
				button.removeEventListener("click", onClick);
				button.remove();
			});
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [html]);

	return (
		<article
			className="docs-prose"
			ref={articleRef}
			// The HTML is rendered from repo-owned markdown with all raw content
			// escaped by renderDocsMarkdown; no user input reaches this string.
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function CopyMarkdownButton({ markdown }: { markdown: string }) {
	const [copied, setCopied] = useState(false);

	return (
		<button
			className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-xs text-fg-subtle transition hover:text-fg"
			type="button"
			onClick={() => {
				void navigator.clipboard.writeText(markdown);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			<Copy className="size-3" aria-hidden="true" />
			{copied ? "copied" : "copy as markdown"}
		</button>
	);
}

function PagerLink({
	entry,
	direction,
}: {
	entry: DocsEntry;
	direction: "previous" | "next";
}) {
	const next = direction === "next";
	return (
		<Link
			className="font-semibold text-fg-muted no-underline transition hover:text-accent"
			to="/docs/$slug"
			params={{ slug: entry.slug }}
		>
			{next ? `${entry.label} →` : `← ${entry.label}`}
		</Link>
	);
}
