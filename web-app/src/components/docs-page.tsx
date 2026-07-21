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

			<div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-0 px-5 sm:px-10 lg:flex-row lg:gap-14">
				<nav
					className="shrink-0 pt-8 lg:sticky lg:top-[90px] lg:max-h-[calc(100vh-90px)] lg:w-[220px] lg:self-start lg:overflow-y-auto lg:pt-10 lg:pb-20"
					aria-label="Docs navigation"
				>
					{Object.entries(docsToc).map(([group, items]) => (
						<div className="mb-[26px] flex flex-col gap-0.5" key={group}>
							<span className="px-2.5 pb-[7px] text-[11.5px] font-bold tracking-[.07em] text-[#b5afa6] uppercase">
								{group}
							</span>
							{items.map((item) => {
								const slug = item.path.replace(/\.md$/, "");
								const active = slug === entry.slug;
								return (
									<Link
										className={cn(
											"block rounded-lg px-2.5 py-[7px] text-sm font-medium text-[#57534e] no-underline hover:text-[#1c1917]",
											active && "bg-[#f7ede0] font-semibold text-[#c2410c]",
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

				<main className="min-w-0 flex-1 pt-6 pb-[120px] lg:pt-11">
					<div className="max-w-[720px]">
						<div className="mb-3.5 flex items-center gap-[7px] text-[13px] text-[#8a8178]">
							<span className="font-semibold">{entry.group}</span>
							<span className="text-[#c9c2b8]">/</span>
							<span className="font-semibold text-[#c2410c]">
								{entry.label}
							</span>
							<span className="flex-1" />
							<CopyMarkdownButton markdown={markdown} />
						</div>
						<DocsArticle html={html} />
						<div className="mt-14 grid grid-cols-1 gap-3.5 border-t border-[#1c1917]/8 pt-6 sm:grid-cols-2">
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

			<footer className="flex items-center justify-between border-t border-[#1c1917]/7 px-5 py-[22px] text-[13.5px] text-[#8a8178] sm:px-10">
				<span className="inline-flex items-center gap-2">
					<img className="size-[15px]" src="/lixray-mark.svg" alt="" />
					<span className="font-semibold text-[#57534e]">LixRay</span>
				</span>
				<span>© 2026 Opral</span>
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
			className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#1c1917]/12 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-[#57534e] transition hover:border-[#e8590c]/45 hover:text-[#1c1917]"
			type="button"
			onClick={() => {
				void navigator.clipboard.writeText(markdown);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			<Copy className="size-3" aria-hidden="true" />
			{copied ? "Copied" : "Copy as Markdown"}
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
			className={cn(
				"flex flex-col gap-1 rounded-xl border border-[#1c1917]/10 bg-white px-[18px] py-3.5 no-underline transition hover:border-[#e8590c]/45",
				next && "items-end text-right sm:col-start-2",
			)}
			to="/docs/$slug"
			params={{ slug: entry.slug }}
		>
			<span className="text-xs font-semibold text-[#8a8178]">
				{next ? "Next →" : "← Previous"}
			</span>
			<span className="text-[14.5px] font-bold text-[#1c1917]">
				{entry.label}
			</span>
		</Link>
	);
}
