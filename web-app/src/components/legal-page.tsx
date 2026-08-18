import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { SiteHeader } from "~/components/site-header";
import { type LegalSlug, legalMarkdown } from "~/lib/docs-content";
import { renderDocsMarkdown } from "~/lib/docs-markdown";

export function LegalPage({ slug }: { slug: LegalSlug }) {
	const markdown = legalMarkdown(slug);
	const { html } = useMemo(() => renderDocsMarkdown(markdown), [markdown]);

	return (
		<div className="flex min-h-screen flex-col bg-[#fbf6f0] font-sans text-[#1c1917] antialiased">
			<SiteHeader sticky />

			<main className="mx-auto w-full max-w-[720px] flex-1 px-5 pt-10 pb-[120px] sm:px-14">
				<article
					className="docs-prose"
					// The HTML is rendered from repo-owned markdown with all raw content
					// escaped by renderDocsMarkdown; no user input reaches this string.
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			</main>

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
