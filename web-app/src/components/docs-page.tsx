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
		<div className="flex min-h-screen flex-col bg-[#fbf6f0] font-sans text-[#1c1917] antialiased">
			<SiteHeader sticky />

			<div className="flex w-full flex-1 flex-col px-5 sm:px-14 lg:flex-row lg:gap-14">
				<nav
					className="shrink-0 pt-8 lg:sticky lg:top-[90px] lg:max-h-[calc(100vh-90px)] lg:w-[200px] lg:self-start lg:overflow-y-auto lg:pt-10 lg:pb-20"
					aria-label="Docs navigation"
				>
					{Object.entries(docsToc).map(([group, items]) => (
						<div className="mb-[26px] flex flex-col gap-1.5" key={group}>
							<span className="pb-1 font-mono text-[11.5px] font-semibold tracking-[.07em] text-[#b5afa6] uppercase">
								{group}
							</span>
							{items.map((item) => {
								const slug = item.path.replace(/\.md$/, "");
								const active = slug === entry.slug;
								return (
									<Link
										className={cn(
											"block py-[3px] text-sm text-[#57534e] no-underline hover:text-[#1c1917]",
											active && "font-semibold text-[#c2410c]",
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

				<main className="min-w-0 flex-1 pt-6 pb-[120px] lg:pt-10">
					<div className="relative max-w-[720px]">
						{/* Pinned to the h1's first line so the heading stays level with
						    the sidebar's group label. */}
						<div className="absolute top-2.5 right-0">
							<CopyMarkdownButton markdown={markdown} />
						</div>
						<DocsArticle html={html} />
						<div className="mt-14 flex items-center justify-between border-t border-[#1c1917]/8 pt-6 text-sm">
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

			<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[#1c1917]/7 px-5 py-6 text-sm text-[#8a8178] sm:px-14">
				<span className="inline-flex items-center gap-2">
					<img className="size-4" src="/lixray-mark.svg" alt="" />
					<span className="font-semibold text-[#57534e]">LixRay</span>
				</span>
				<a
					className="no-underline hover:text-[#57534e]"
					href="https://opral.com"
					target="_blank"
					rel="noreferrer"
				>
					© 2026 Opral
				</a>
				<nav className="flex flex-wrap items-center gap-4">
					<Link className="no-underline hover:text-[#57534e]" to="/privacy">
						Privacy
					</Link>
					<Link className="no-underline hover:text-[#57534e]" to="/terms">
						Terms
					</Link>
					<Link className="no-underline hover:text-[#57534e]" to="/support">
						Support
					</Link>
					<a
						className="font-semibold text-[#57534e] no-underline"
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
			className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-xs text-[#8a8178] transition hover:text-[#1c1917]"
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
			className="font-semibold text-[#57534e] no-underline transition hover:text-[#c2410c]"
			to="/docs/$slug"
			params={{ slug: entry.slug }}
		>
			{next ? `${entry.label} →` : `← ${entry.label}`}
		</Link>
	);
}
