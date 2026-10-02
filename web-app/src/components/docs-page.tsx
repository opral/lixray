import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiteFooter, SiteHeader } from "~/components/site-header";
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
				<details
					key={entry.slug}
					className="docs-navigation-mobile mb-6 rounded-[10px] border border-border bg-panel"
				>
					<summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold">
						{entry.label}
						<span className="text-fg-subtle" aria-hidden="true">
							Contents ▾
						</span>
					</summary>
					<div className="border-t border-border-subtle px-4 pt-4">
						<DocsNavLinks activeSlug={entry.slug} />
					</div>
				</details>
				<nav className="docs-navigation" aria-label="Docs navigation">
					<DocsNavLinks activeSlug={entry.slug} />
				</nav>

				<main className="docs-main">
					<div className="docs-content relative">
						{/* Beside the h1 from 768px, so it costs no vertical space. */}
						<div className="mb-4 flex justify-end md:absolute md:top-2 md:right-0 md:mb-0">
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

			<SiteFooter />
		</div>
	);
}

function DocsNavLinks({ activeSlug }: { activeSlug: string }) {
	return Object.entries(docsToc).map(([group, items]) => (
		<div className="mb-5 flex flex-col gap-0.5" key={group}>
			<span className="pb-1 font-mono text-[11.5px] font-semibold tracking-[.07em] text-fg-faint uppercase">
				{group}
			</span>
			{items.map((item) => {
				const slug = item.path.replace(/\.md$/, "");
				return (
					<Link
						className={cn(
							"block py-1.5 text-sm text-fg-muted no-underline hover:text-fg",
							slug === activeSlug && "font-semibold text-accent",
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
	));
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
			// Wrap the scrolling <pre> so the button stays in its corner.
			const wrapper = document.createElement("div");
			wrapper.className = "docs-code";
			pre.before(wrapper);
			wrapper.append(pre, button);
			cleanups.push(() => {
				button.removeEventListener("click", onClick);
				wrapper.before(pre);
				wrapper.remove();
			});
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [html]);

	return (
		<article
			className="atelier-document docs-article"
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
