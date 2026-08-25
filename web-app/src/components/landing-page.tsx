import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SiteHeader, useRepositoryCta } from "~/components/site-header";

const primaryButton =
	"inline-flex items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-[22px] py-3 text-base font-bold whitespace-nowrap text-white no-underline shadow-[0_6px_16px_rgba(232,89,12,.3),inset_0_1px_0_rgba(255,255,255,.25)] transition hover:brightness-105";
const secondaryButton =
	"inline-flex items-center justify-center rounded-[10px] border border-[#1c1917]/15 bg-white px-5 py-[11px] text-base font-semibold whitespace-nowrap text-[#1c1917] no-underline transition hover:border-[#1c1917]/30";
const bookDemoHref = "mailto:hello@opral.com?subject=LixRay%20demo";

export function LandingPage() {
	const { user, repositoryTo } = useRepositoryCta();
	const heroCtaLabel = user ? "Open LixRay" : "Create your repo for free";

	const ctaRow = (
		<div className="flex flex-wrap items-center gap-3">
			<a className={primaryButton} href={repositoryTo}>
				{heroCtaLabel}
			</a>
			<a className={secondaryButton} href={bookDemoHref}>
				Book a demo
			</a>
		</div>
	);

	return (
		<div className="min-h-screen bg-[#fbf6f0] font-sans text-[#1c1917] antialiased">
			<SiteHeader />

			<main className="mx-auto flex w-full max-w-[660px] flex-col gap-16 px-6 pt-16 pb-[130px] sm:px-8 sm:pt-20">
				<section
					className="flex flex-col items-start gap-[22px]"
					aria-labelledby="landing-title"
				>
					{/* Design 26a: the audience phrase rotates on a CSS reel — no
					    interaction, no JS. The reel spans company and personal
					    audiences, replacing the old pitch toggle. All phrases stay
					    in the DOM for crawlers; the aria-label keeps the accessible
					    name stable. */}
					<h1
						className="m-0 text-[clamp(2.25rem,5.5vw,2.875rem)] leading-[1.12] font-bold tracking-[-.03em]"
						id="landing-title"
						aria-label="A repository for your entire company"
					>
						A repository for
						<br />
						your{" "}
						<span className="landing-headline-slot">
							<span className="landing-headline-reel">
								<span>entire company</span>
								<span>sales team</span>
								<span>marketing team</span>
								<span>personal life</span>
								{/* Duplicate of the first phrase closes the loop. */}
								<span aria-hidden="true">entire company</span>
							</span>
						</span>
					</h1>
					<style>{`
						.landing-headline-slot {
							display: inline-block;
							overflow: hidden;
							height: 1.12em;
							vertical-align: bottom;
							color: #e8590c;
						}
						.landing-headline-reel {
							display: flex;
							flex-direction: column;
							animation: landing-headline-rotate 10s infinite
								cubic-bezier(0.6, 0, 0.2, 1);
						}
						.landing-headline-reel > span {
							white-space: nowrap;
							line-height: 1.12;
						}
						@keyframes landing-headline-rotate {
							0%, 18% { transform: translateY(0); }
							23%, 41% { transform: translateY(-20%); }
							46%, 64% { transform: translateY(-40%); }
							69%, 87% { transform: translateY(-60%); }
							92%, 100% { transform: translateY(-80%); }
						}
						@media (prefers-reduced-motion: reduce) {
							.landing-headline-reel { animation: none; }
						}
					`}</style>
					<p className="m-0 text-lg leading-[1.6] text-[#57534e] text-pretty">
						One repo you and your agents share. Any file type, every change
						tracked.
					</p>
					<div className="mt-0.5">{ctaRow}</div>
					<div className="flex flex-wrap items-center gap-[9px] text-sm text-[#8a8178]">
						<span>Works with</span>
						<span
							className="inline-flex items-center gap-2"
							aria-label="Claude, ChatGPT, and Gemini"
						>
							<img
								className="size-4"
								src="/landing/claude-spark.svg"
								alt="Claude"
							/>
							<img
								className="size-4 object-contain"
								src="/landing/brand-openai.svg"
								alt="ChatGPT"
							/>
							<img
								className="size-4 object-contain"
								src="/landing/brand-gemini.svg"
								alt="Gemini"
							/>
						</span>
						<span>and any MCP agent</span>
					</div>
					<div className="w-full self-stretch overflow-hidden rounded-xl border border-[#1c1917]/12 bg-white">
						<div className="flex items-center gap-2 border-b border-[#1c1917]/8 bg-[#f7f3ed] px-5 py-2.5 font-mono text-[12.5px] text-[#8a8178]">
							lixray.com/<b className="text-[#1c1917]">@acme/repository</b>
						</div>
						<div className="flex flex-col gap-2.5 px-6 py-5 font-mono text-[13.5px]">
							<RepoRow folder="sales/">
								playbook.md · icp.md · leads.csv
							</RepoRow>
							<RepoRow folder="brand/">
								logo.png · launch-video.mp4 · deck.pdf
							</RepoRow>
							<RepoRow folder="skills/">
								call-prep/SKILL.md · research/SKILL.md
							</RepoRow>
							<RepoRow folder="automations/">
								crm-sync.py · weekly-report.js
							</RepoRow>
						</div>
					</div>
				</section>

				<section
					className="flex flex-col gap-[18px]"
					aria-labelledby="why-title"
				>
					<h2
						className="m-0 text-2xl font-bold tracking-[-.02em]"
						id="why-title"
					>
						Why?
					</h2>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Sharing skills.</b> Write a skill once. Every agent on the team
						runs the same version.
					</p>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Storing automations.</b> The scripts your agents run on a
						schedule, versioned and reviewable.
					</p>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Context layer for agents.</b> Agents read the ICP and the
						playbook from one place. Always the current version.
					</p>
				</section>

				<section
					className="flex flex-col gap-[18px]"
					aria-labelledby="comparison-title"
				>
					<h2
						className="m-0 text-2xl font-bold tracking-[-.02em]"
						id="comparison-title"
					>
						Comparison
					</h2>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<Link
							className="text-[#44403c] underline decoration-[#44403c]/30 underline-offset-2 hover:text-[#e8590c] hover:decoration-[#e8590c]/40"
							to="/lp/lixray-vs-github"
						>
							<b>GitHub</b> is too technical (branch, commit, pull request) and
							lacks permissions.
						</Link>
					</p>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Google Drive</b> has no version control and is not designed for
						programmatic usage.
					</p>
				</section>
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

function RepoRow({
	folder,
	children,
}: {
	folder: string;
	children: ReactNode;
}) {
	return (
		<span className="flex flex-col gap-0.5 sm:flex-row sm:gap-3.5">
			<span className="w-[130px] shrink-0 font-bold text-[#c2410c]">
				{folder}
			</span>
			<span className="text-[#8a8178]">{children}</span>
		</span>
	);
}
