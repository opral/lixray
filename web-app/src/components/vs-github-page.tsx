import { Link } from "@tanstack/react-router";
import {
	BookOpen,
	DollarSign,
	type LucideIcon,
	Megaphone,
	Sparkles,
	TrendingUp,
	Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { SiteHeader, useRepositoryCta } from "~/components/site-header";
import { cn } from "~/lib/utils";

const primaryButton =
	"inline-flex items-center justify-center rounded-xl bg-[image:var(--at-accent-gradient)] px-7 py-[15px] text-[17px] font-bold whitespace-nowrap text-accent-on no-underline shadow-accent transition hover:brightness-105";
const secondaryButton =
	"inline-flex items-center justify-center rounded-xl border border-fg/12 bg-panel px-6 py-3.5 text-base font-semibold whitespace-nowrap text-fg no-underline transition hover:border-fg/25";
const visualCard =
	"rounded-2xl border border-fg/8 bg-panel shadow-[0_24px_60px_color-mix(in_srgb,var(--at-overlay)_8%,transparent)]";

export function VsGithubPage() {
	const { user, repositoryTo } = useRepositoryCta();
	const heroCtaLabel = user ? "Open LixRay" : "Create your repo for free";

	return (
		<div className="min-h-screen bg-panel font-sans text-fg antialiased">
			<SiteHeader />

			<main>
				<section
					className="flex flex-col items-center gap-6 px-5 pt-10 text-center sm:px-14 sm:pt-[90px]"
					aria-labelledby="landing-title"
				>
					<h1
						className="m-0 max-w-[1060px] text-[clamp(2.5rem,6vw,4rem)] leading-[1.08] font-bold tracking-[-.035em] text-balance"
						id="landing-title"
					>
						GitHub is for engineers.
						<br />
						LixRay is for the rest of your company.
					</h1>
					<p className="m-0 max-w-[680px] text-[21px] leading-[1.55] text-fg-muted text-pretty">
						One repo for GTM, ops, sales, finance, and the agents working in
						them.
					</p>
					<div className="mt-3 flex flex-wrap items-center justify-center gap-3">
						<a className={primaryButton} href={repositoryTo}>
							{heroCtaLabel}
						</a>
						{user ? null : (
							<a className={secondaryButton} href="/sign-in">
								Sign in
							</a>
						)}
					</div>
					<div className="mt-0.5 flex flex-wrap items-center justify-center gap-2.5 text-sm text-fg-subtle">
						<span>Works with</span>
						<span
							className="inline-flex items-center gap-2"
							aria-label="Claude, ChatGPT, Gemini, and Codex"
						>
							<img
								className="size-[17px]"
								src="/landing/claude-spark.svg"
								alt="Claude"
							/>
							<img
								className="size-[17px] object-contain"
								src="/landing/brand-openai.svg"
								alt="ChatGPT"
							/>
							<img
								className="size-[17px] object-contain"
								src="/landing/brand-gemini.svg"
								alt="Gemini"
							/>
							<img
								className="size-4"
								src="/landing/codex-icon.svg"
								alt="Codex"
							/>
						</span>
						<span>and any MCP or CLI agent</span>
					</div>
				</section>

				<div className="flex justify-center px-5 pt-14 pb-16 sm:px-14 sm:pt-16 lg:pb-[100px]">
					<HeroVisual />
				</div>

				<section
					className="border-t border-fg/7 bg-panel"
					aria-labelledby="git-wall-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-[22px] px-5 py-20 sm:px-14 sm:py-[110px]">
						<h2
							className="m-0 text-[clamp(2rem,4.5vw,2.5rem)] leading-[1.12] font-bold tracking-[-.03em] text-balance"
							id="git-wall-title"
						>
							Non-developers struggle with GitHub
						</h2>
						<p className="m-0 max-w-[640px] text-[17px] leading-[1.6] text-fg-muted text-pretty">
							Companies set up GitHub repos for good reason: one source of
							truth, real review, agents that ship. But GitHub is built for
							software engineers. Everyone else hits three walls.
						</p>
						<div className="mt-[26px] flex flex-col items-start gap-8 rounded-2xl border border-fg/8 bg-bg px-8 py-7 lg:flex-row lg:items-center lg:gap-12">
							<div className="flex max-w-[340px] shrink-0 flex-col gap-3">
								<h3 className="m-0 text-xl font-bold tracking-[-.01em]">
									Branching, commits and pull requests are too complicated
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-fg-muted text-pretty">
									Clone, branch, stage, commit, open a PR, resolve conflicts.
									That workflow is built for engineers shipping code. Everyone
									else just needs to make a change and move on.
								</p>
							</div>
							<div className="flex w-full flex-1 flex-col gap-1.5">
								<div className="flex items-center gap-3.5">
									<span className="w-[110px] shrink-0 text-[11px] leading-[1.5] font-bold tracking-[.06em] text-fg-subtle uppercase">
										Git
									</span>
									<div className="relative h-[88px] flex-1">
										<svg
											className="absolute inset-0"
											width="100%"
											height="88"
											viewBox="0 0 400 88"
											preserveAspectRatio="none"
											aria-hidden="true"
										>
											<path
												d="M0 62 H400"
												stroke="var(--at-border-strong)"
												strokeWidth="1.5"
											/>
											<path
												d="M56 62 C 76 62, 76 26, 100 26 H 302 C 326 26, 326 62, 346 62"
												stroke="var(--at-border-strong)"
												strokeWidth="1.5"
												strokeDasharray="4 4"
												fill="none"
											/>
											<circle cx="56" cy="62" r="4" fill="var(--at-fg)" />
											<circle cx="346" cy="62" r="4" fill="var(--at-accent)" />
										</svg>
										<span className="absolute bottom-0.5 left-[3%] inline-flex items-center rounded-[5px] bg-bg-hover-strong px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-fg-muted">
											create branch
										</span>
										<span className="absolute top-1.5 left-[30%] inline-flex items-center rounded-[5px] bg-bg-hover-strong px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-fg-muted">
											open PR
										</span>
										<span className="absolute top-1.5 left-[58%] inline-flex items-center rounded-[5px] bg-bg-hover-strong px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-fg-muted">
											wait for CI
										</span>
										<span className="absolute right-0 bottom-0.5 inline-flex items-center rounded-[5px] bg-overlay px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-overlay-fg">
											merged · next day
										</span>
									</div>
								</div>
								<div className="flex items-start gap-3.5">
									<span className="w-[110px] shrink-0 text-[11px] leading-[1.5] font-bold tracking-[.06em] text-accent uppercase">
										Non-devs want
									</span>
									<div className="relative h-12 flex-1">
										<span className="absolute top-[18px] right-0 left-0 h-[1.5px] bg-border-strong" />
										<span className="absolute top-[18px] left-[10%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
										<span className="absolute top-[18px] left-[40%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
										<span className="absolute top-[18px] left-[68%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
										<span className="absolute top-[30px] left-[10%] -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-accent">
											edit plan
										</span>
										<span className="absolute top-[30px] left-[40%] -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-accent">
											update csv
										</span>
										<span className="absolute top-[30px] left-[68%] -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-accent">
											fix pricing
										</span>
										<span className="absolute top-[18px] right-0 inline-flex -translate-y-1/2 items-center rounded-[5px] border border-accent-border bg-accent-subtle px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-accent">
											done
										</span>
									</div>
								</div>
							</div>
						</div>
						<div className="grid gap-6 sm:grid-cols-2">
							<div className="flex flex-col gap-3 rounded-2xl border border-fg/8 bg-bg p-7">
								<span className="inline-flex items-center gap-[7px]">
									<img
										className="size-[19px] opacity-55 grayscale"
										src="/landing/icon-sq-mp4.svg"
										alt=""
									/>
									<img
										className="size-[19px] opacity-55 grayscale"
										src="/landing/icon-sq-pdf.svg"
										alt=""
									/>
									<img
										className="size-[19px] opacity-55 grayscale"
										src="/landing/icon-sq-png.svg"
										alt=""
									/>
								</span>
								<h3 className="m-0 mt-1.5 text-xl font-bold tracking-[-.01em]">
									Large files are a problem
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-fg-muted text-pretty">
									Git chokes on big binaries. The launch video, the board deck,
									design files: everything needs LFS, a bolt-on with size
									limits, extra setup, and its own bills.
								</p>
								<div className="mt-2 flex flex-col gap-[5px] rounded-[10px] bg-overlay px-3.5 py-3 font-mono text-[11.5px] leading-[1.5]">
									<span className="text-overlay-fg">
										<span className="text-overlay-fg-subtle">$</span> git push
									</span>
									<span className="text-overlay-danger">
										remote: error: launch-video.mp4 is 2.1 GB
									</span>
									<span className="text-overlay-danger">
										remote: this exceeds the 100 MB file limit
									</span>
									<span className="text-overlay-fg-subtle">
										! [remote rejected] main -&gt; main
									</span>
								</div>
							</div>
							<div className="flex flex-col gap-3 rounded-2xl border border-fg/8 bg-bg p-7">
								<span className="inline-flex items-center gap-1.5 font-mono text-xs text-fg-subtle">
									<span className="inline-flex items-center gap-[5px] rounded-[5px] bg-bg-hover-strong px-2 py-[3px]">
										<LockIcon size={11} />
										all-or-nothing
									</span>
								</span>
								<h3 className="m-0 mt-1.5 text-xl font-bold tracking-[-.01em]">
									No permissions
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-fg-muted text-pretty">
									Access is per-repo, all or nothing. No view-only, no
									finance-only folder, no approvals. Anyone who is in can change
									anything.
								</p>
								<div className="mt-2 flex flex-col gap-0.5 rounded-[10px] border border-fg/8 bg-panel p-2">
									<div className="flex items-center gap-[9px] rounded-[7px] px-2 py-1.5">
										<img
											className="size-[15px]"
											src="/landing/icon-folder.svg"
											alt=""
										/>
										<span className="text-[12.5px] font-semibold text-fg">
											gtm
										</span>
										<span className="ml-auto inline-flex items-center rounded-full border border-border bg-bg-hover px-[9px] py-0.5 text-[11px] font-semibold text-fg-muted">
											Everyone · edit
										</span>
									</div>
									<div className="flex items-center gap-[9px] rounded-[7px] px-2 py-1.5">
										<img
											className="size-[15px]"
											src="/landing/icon-folder.svg"
											alt=""
										/>
										<span className="text-[12.5px] font-semibold text-fg">
											sales
										</span>
										<span className="ml-auto inline-flex items-center rounded-full border border-border bg-bg-hover px-[9px] py-0.5 text-[11px] font-semibold text-fg-muted">
											Everyone · edit
										</span>
									</div>
									<div className="flex items-center gap-[9px] rounded-[7px] bg-danger-subtle px-2 py-1.5">
										<img
											className="size-[15px]"
											src="/landing/icon-folder.svg"
											alt=""
										/>
										<span className="text-[12.5px] font-semibold text-fg">
											finance
										</span>
										<span className="text-[11px] text-danger-border">
											salaries, board decks
										</span>
										<span className="ml-auto inline-flex items-center rounded-full border border-danger/25 bg-panel px-[9px] py-0.5 text-[11px] font-semibold text-danger-border">
											Everyone · edit
										</span>
									</div>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section
					className="border-t border-fg/7 bg-bg"
					aria-labelledby="offers-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-24 px-5 py-24 sm:px-14 sm:py-[120px] lg:gap-[120px]">
						<div className="-mb-14 flex flex-col items-center text-center lg:-mb-[70px]">
							<h2
								className="m-0 text-[clamp(2rem,4.5vw,2.375rem)] leading-[1.12] font-bold tracking-[-.03em]"
								id="offers-title"
							>
								What LixRay does instead
							</h2>
						</div>
						<Band
							reverse
							label="Suggestions instead of pull requests"
							title="Understandable by non-developers"
							body="Suggest a change, the owner accepts or rejects it. Checkpoints instead of commits. No branching to learn."
							visual={<ProposalsVisual />}
						/>
						<Band
							label="Beyond text files"
							title="Every file format is first-class"
							body="One history for the 2.1 GB launch video, the board PDF, the pipeline CSV, and the launch plan. Prose diffs as prose, spreadsheets diff row by row, large assets keep every version. No size limits, no LFS setup."
							visual={<FileFormatsVisual />}
						/>
						<Band
							reverse
							label="Branching optional"
							title="Real-time collaboration"
							body="Non-developers want a simple mental model: make a change, it lands in one linear history. Branching and async review are supported for workflows that need them."
							visual={<ActivityVisual />}
						/>
						<Band
							soon
							label="Access control"
							title="Permissions"
							body="Who can see, who can edit, who approves. Git hosts control who can push, not who can see. There's no “finance can read this folder, sales can't.”"
							visual={<PermissionsVisual />}
						/>
						<Band
							reverse
							soon
							label="Visibility"
							title="Insights"
							body="See which files and skills your agents actually read and use. Know what context matters and what is dead weight."
							visual={<InsightsVisual />}
						/>
					</div>
				</section>

				<section
					className="border-t border-fg/7 bg-panel"
					aria-labelledby="what-goes-in-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-14 px-5 py-24 sm:px-14 sm:py-[110px]">
						<div className="flex flex-col items-center gap-3.5 text-center">
							<h2
								className="m-0 text-[clamp(2rem,4.5vw,2.375rem)] leading-[1.12] font-bold tracking-[-.03em]"
								id="what-goes-in-title"
							>
								What goes in the company repo
							</h2>
							<p className="m-0 max-w-[560px] text-[17px] leading-[1.55] text-fg-muted text-pretty">
								Everything a 5–20 person startup runs on that isn&apos;t source
								code.
							</p>
						</div>
						<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
							<RepoArea
								path="skills/"
								title="Skills"
								Icon={Sparkles}
								body="The SKILL.md files and prompts your agents run on. Diff each revision; roll back the edit that broke behavior."
							/>
							<RepoArea
								path="gtm/"
								title="Go-to-market"
								Icon={Megaphone}
								body="Launch plans, messaging, positioning docs, the pricing one-pager. Agents keep them consistent with each other."
							/>
							<RepoArea
								path="sales/"
								title="Sales"
								Icon={TrendingUp}
								body="The pipeline CSV, call notes, proposals. An agent updates the pipeline after every call. You review the diff."
							/>
							<RepoArea
								path="ops/"
								title="Operations"
								Icon={Wrench}
								body='Runbooks, vendor lists, onboarding checklists. The files that answer "how do we do this here."'
							/>
							<RepoArea
								path="finance/"
								title="Finance"
								Icon={DollarSign}
								body="The budget, the model, board decks. Every version kept; every change attributed."
							/>
							<RepoArea
								path="kb/"
								title="Knowledge base"
								Icon={BookOpen}
								body="Policies, FAQs, product facts. The answers your team and agents rely on, kept current and trustworthy."
							/>
						</div>
						<div className="flex items-center gap-[18px]">
							<span className="flex-1 border-t-[1.5px] border-dashed border-border-strong" />
							<span className="text-sm font-bold whitespace-nowrap text-fg-subtle">
								What does not go in
							</span>
							<span className="flex-1 border-t-[1.5px] border-dashed border-border-strong" />
						</div>
						<div className="flex flex-col items-start gap-6 rounded-[14px] border border-fg/6 bg-bg-hover px-7 py-6 lg:flex-row lg:items-center lg:gap-9">
							<p className="m-0 max-w-[340px] text-base leading-[1.55] text-fg text-pretty">
								<b>Your source code stays in GitHub.</b> LixRay is for the repos
								that are not source code.
							</p>
							<div className="flex flex-1 flex-wrap items-center justify-center gap-4 lg:flex-nowrap">
								<div className="flex shrink-0 flex-col gap-[11px] rounded-xl border border-fg/10 bg-panel px-[18px] py-4">
									<span className="inline-flex items-center gap-2">
										<img
											className="size-4"
											src="/landing/brand-github.svg"
											alt="GitHub"
										/>
										<span className="font-mono text-[12.5px] font-bold text-fg">
											github.com/acme
										</span>
									</span>
									<span className="inline-flex items-center gap-1.5">
										<RepoChip variant="github">frontend</RepoChip>
										<RepoChip variant="github">backend</RepoChip>
									</span>
									<span className="text-[11.5px] font-semibold text-fg-subtle">
										source code
									</span>
								</div>
								<span className="text-lg font-semibold text-fg-faint">+</span>
								<div className="flex flex-col gap-[11px] rounded-xl border border-accent-border bg-accent-subtle px-[18px] py-4">
									<span className="inline-flex items-center gap-2">
										<img
											className="size-4"
											src="/landing/lixray-glyph.svg"
											alt="LixRay"
										/>
										<span className="font-mono text-[12.5px] font-bold text-fg">
											lixray.com/@acme/company
										</span>
									</span>
									<span className="inline-flex flex-wrap items-center gap-1.5">
										<RepoChip>gtm</RepoChip>
										<RepoChip>sales</RepoChip>
										<RepoChip>ops</RepoChip>
										<RepoChip>finance</RepoChip>
										<RepoChip>skills</RepoChip>
									</span>
									<span className="text-[11.5px] font-semibold text-accent">
										everything else
									</span>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section className="flex flex-col items-center gap-[22px] border-t border-fg/7 bg-panel px-5 py-24 text-center sm:py-[120px]">
					<h2 className="m-0 max-w-[720px] text-[clamp(2rem,4.5vw,2.625rem)] leading-[1.1] font-bold tracking-[-.03em] text-balance">
						Put your company into a repo
					</h2>
					<a className={cn(primaryButton, "mt-1")} href={repositoryTo}>
						{heroCtaLabel}
					</a>
				</section>
			</main>

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

function HeroVisual() {
	return (
		<div
			className="flex flex-col items-center justify-center gap-7 lg:flex-row lg:gap-0"
			aria-label="Agents in ChatGPT, Slack, Claude, and the terminal all working against one LixRay repository"
		>
			<div className="flex w-[300px] shrink-0 flex-col gap-7">
				<div className="overflow-hidden rounded-[14px] border border-fg/18 bg-panel shadow-[0_18px_44px_color-mix(in_srgb,var(--at-overlay)_10%,transparent)]">
					<div className="flex items-center gap-2 bg-overlay px-3.5 py-2.5">
						<img
							className="size-3.5 object-contain brightness-0 invert"
							src="/landing/brand-openai.svg"
							alt=""
						/>
						<span className="text-[12.5px] font-bold text-accent-on">
							ChatGPT
						</span>
						<span className="ml-auto text-[11px] text-fg-faint">Jonas</span>
					</div>
					<div className="flex flex-col gap-2 px-3.5 py-3">
						<div className="max-w-[230px] self-end rounded-[14px] bg-bg-hover-strong px-3 py-[7px] text-[12.5px] leading-[1.45] text-fg">
							Move Northwind to Negotiation, $48k
						</div>
						<span className="inline-flex items-center gap-1.5 self-start rounded-full border border-border bg-bg-subtle px-2.5 py-1 text-[11.5px] text-fg-muted">
							<CheckIcon size={10} />
							Edited pipeline.csv
						</span>
					</div>
				</div>
				<div className="overflow-hidden rounded-[14px] border border-fg/10 bg-panel shadow-[0_18px_44px_color-mix(in_srgb,var(--at-overlay)_10%,transparent)]">
					<div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
						<img
							className="size-3.5"
							src="/landing/brand-slack.svg"
							alt="Slack"
						/>
						<span className="text-[13px] font-extrabold text-fg">
							#go-to-market
						</span>
						<span className="ml-auto text-[11px] text-fg-faint">
							24 members
						</span>
					</div>
					<div className="flex flex-col gap-3 px-3.5 py-3">
						<div className="flex gap-[9px]">
							<span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-overlay text-[11px] font-bold text-overlay-fg">
								M
							</span>
							<span className="flex flex-col gap-0.5">
								<span className="text-xs">
									<b className="text-fg">Mara</b>{" "}
									<span className="text-[11px] text-fg-faint">2:03 PM</span>
								</span>
								<span className="text-[12.5px] leading-[1.45] text-fg">
									<span className="rounded bg-tag-blue px-[3px] font-semibold text-tag-blue-fg">
										@Claude
									</span>{" "}
									update the runbook with the new on-call rotation
								</span>
							</span>
						</div>
						<div className="flex gap-[9px]">
							<span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-accent-subtle">
								<img
									className="size-[13px]"
									src="/landing/claude-spark.svg"
									alt=""
								/>
							</span>
							<span className="flex flex-col gap-0.5">
								<span className="text-xs">
									<b className="text-fg">Claude</b>{" "}
									<span className="rounded-[3px] bg-bg-hover-strong px-1 py-px text-[9.5px] font-bold text-fg-subtle">
										APP
									</span>{" "}
									<span className="text-[11px] text-fg-faint">2:04 PM</span>
								</span>
								<span className="text-[12.5px] leading-[1.45] text-fg">
									Done. Proposed an edit to{" "}
									<span className="rounded bg-bg-hover px-1 font-mono text-[11.5px]">
										ops/runbook.md
									</span>
								</span>
							</span>
						</div>
					</div>
				</div>
			</div>
			<svg
				className="hidden shrink-0 lg:block"
				width="80"
				height="320"
				viewBox="0 0 80 320"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M0 70 C 44 70, 36 160, 80 160"
					stroke="var(--at-border-strong)"
					strokeWidth="1.5"
				/>
				<path
					d="M0 250 C 44 250, 36 160, 80 160"
					stroke="var(--at-border-strong)"
					strokeWidth="1.5"
				/>
				<circle cx="80" cy="160" r="3" fill="var(--at-accent)" />
			</svg>
			<div className="flex w-[320px] shrink-0 flex-col gap-px rounded-2xl border border-fg/10 bg-panel px-3 py-[18px] text-[13px] text-fg shadow-[0_30px_80px_color-mix(in_srgb,var(--at-overlay)_14%,transparent)]">
				<span className="mx-1 mb-3 flex rounded-lg border border-border bg-bg px-3 py-[7px] font-mono text-xs text-fg-subtle">
					<span>
						lixray.com/<b className="text-fg">@acme/company</b>
					</span>
				</span>
				<TreeFolder>gtm</TreeFolder>
				<TreeFile icon="/landing/icon-sq-md.svg">launch-plan.md</TreeFile>
				<TreeFile icon="/landing/icon-sq-pdf.svg">
					pricing-onepager.pdf
				</TreeFile>
				<TreeFolder>sales</TreeFolder>
				<TreeFile
					icon="/landing/icon-sq-csv.svg"
					highlighted
					meta={
						<span className="font-mono text-[11.5px]">
							<span className="text-success-border">+12</span>{" "}
							<span className="text-danger-border">−3</span>
						</span>
					}
				>
					pipeline.csv
				</TreeFile>
				<TreeFile icon="/landing/icon-sq-md.svg">call-notes.md</TreeFile>
				<TreeFolder>ops</TreeFolder>
				<TreeFile
					icon="/landing/icon-sq-md.svg"
					highlighted
					meta={
						<span className="font-mono text-[11.5px]">
							<span className="text-success-border">+3</span>{" "}
							<span className="text-danger-border">−3</span>
						</span>
					}
				>
					runbook.md
				</TreeFile>
				<TreeFolder>finance</TreeFolder>
				<TreeFile icon="/landing/icon-sq-csv.svg">budget-2026.csv</TreeFile>
				<TreeFile
					icon="/landing/icon-sq-pdf.svg"
					highlighted
					meta={
						<span className="font-mono text-[11.5px] text-fg-subtle">
							v4 → v5
						</span>
					}
				>
					board-deck.pdf
				</TreeFile>
				<TreeFolder>skills</TreeFolder>
				<TreeFile icon="/landing/icon-sq-md.svg">research/SKILL.md</TreeFile>
			</div>
			<svg
				className="hidden shrink-0 lg:block"
				width="80"
				height="320"
				viewBox="0 0 80 320"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M80 70 C 36 70, 44 160, 0 160"
					stroke="var(--at-border-strong)"
					strokeWidth="1.5"
				/>
				<path
					d="M80 250 C 36 250, 44 160, 0 160"
					stroke="var(--at-border-strong)"
					strokeWidth="1.5"
				/>
				<circle cx="0" cy="160" r="3" fill="var(--at-accent)" />
			</svg>
			<div className="flex w-[300px] shrink-0 flex-col gap-7">
				<div className="overflow-hidden rounded-[14px] border border-accent-border bg-accent-subtle shadow-[0_18px_44px_color-mix(in_srgb,var(--at-overlay)_10%,transparent)]">
					<div className="flex items-center gap-2 px-3.5 py-2.5">
						<img className="size-3.5" src="/landing/claude-spark.svg" alt="" />
						<span className="text-[12.5px] font-bold text-accent">Claude</span>
						<span className="ml-auto text-[11px] text-fg-subtle">Mara</span>
					</div>
					<div className="flex flex-col gap-2 px-3.5 pb-3">
						<div className="max-w-[230px] self-end rounded-[14px_14px_4px_14px] bg-accent-border px-3 py-[7px] text-[12.5px] leading-[1.45] text-fg">
							Rewrite launch pricing to usage-based
						</div>
						<span className="inline-flex items-center gap-1.5 self-start rounded-full border border-accent-border bg-panel px-2.5 py-1 text-[11.5px] text-accent">
							<CheckIcon size={10} />
							Proposed edit to launch-plan.md
						</span>
					</div>
				</div>
				<div className="flex flex-col overflow-hidden rounded-[14px] bg-overlay shadow-[0_18px_44px_color-mix(in_srgb,var(--at-overlay)_20%,transparent)]">
					<div className="flex items-center gap-1.5 bg-overlay-raised px-3 py-[9px]">
						<span
							className="size-2.5 rounded-full bg-[#ff5f57]" /* token-literal: macOS window control */
						/>
						<span
							className="size-2.5 rounded-full bg-[#febc2e]" /* token-literal: macOS window control */
						/>
						<span
							className="size-2.5 rounded-full bg-[#28c840]" /* token-literal: macOS window control */
						/>
						<span className="flex-1 pr-[42px] text-center text-[11px] text-fg-faint">
							Terminal
						</span>
					</div>
					<div className="flex flex-col gap-[7px] px-4 pt-3 pb-3.5 font-mono text-xs leading-[1.5]">
						<span className="text-overlay-fg">
							<span className="text-overlay-fg-subtle">$</span> codex &quot;new
							board deck version&quot;
						</span>
						<span className="text-overlay-success">
							✓ uploaded finance/board-deck.pdf v5
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

function TreeFolder({ children }: { children: ReactNode }) {
	return (
		<span className="flex items-center gap-2 px-2.5 py-1.5 font-bold">
			<img className="size-4" src="/landing/icon-folder.svg" alt="" />
			{children}
		</span>
	);
}

function TreeFile({
	icon,
	children,
	highlighted = false,
	meta,
}: {
	icon: string;
	children: ReactNode;
	highlighted?: boolean;
	meta?: ReactNode;
}) {
	return (
		<span
			className={cn(
				"flex items-center gap-2 py-[5px] pr-2.5 pl-[34px]",
				highlighted && "rounded-[7px] bg-accent-subtle font-semibold",
			)}
		>
			<img className="size-[15px]" src={icon} alt="" />
			{children}
			{meta ? <span className="ml-auto">{meta}</span> : null}
		</span>
	);
}

function RepoChip({
	children,
	variant = "lixray",
}: {
	children: ReactNode;
	variant?: "github" | "lixray";
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-[5px] rounded-md border px-[9px] py-1 font-mono text-[11px] text-fg-muted",
				variant === "github"
					? "border-border bg-bg-subtle"
					: "border-accent-border bg-panel",
			)}
		>
			<img
				className={cn("size-3", variant === "github" && "opacity-60 grayscale")}
				src="/landing/icon-folder.svg"
				alt=""
			/>
			{children}
		</span>
	);
}

function Band({
	label,
	title,
	body,
	visual,
	reverse = false,
	soon = false,
}: {
	label: string;
	title: string;
	body: string;
	visual: ReactNode;
	reverse?: boolean;
	soon?: boolean;
}) {
	return (
		<article
			className={cn(
				"grid items-center gap-10 lg:gap-[90px]",
				reverse ? "lg:grid-cols-[1fr_400px]" : "lg:grid-cols-[400px_1fr]",
			)}
		>
			<div className={cn("flex flex-col gap-4", reverse && "lg:order-2")}>
				<span className="text-sm font-bold tracking-[.02em] text-accent">
					{label}
				</span>
				<div className="flex items-center gap-3">
					<h3 className="m-0 text-[30px] leading-[1.18] font-bold tracking-[-.02em]">
						{title}
					</h3>
					{soon ? (
						<span className="rounded-full border border-accent-border bg-accent-subtle px-2.5 py-[3px] text-[10.5px] font-bold tracking-[.06em] text-accent uppercase">
							Soon
						</span>
					) : null}
				</div>
				<p className="m-0 text-[16.5px] leading-[1.6] text-fg-muted text-pretty">
					{body}
				</p>
			</div>
			<div className={cn(reverse && "lg:order-1")}>{visual}</div>
		</article>
	);
}

function FileFormatsVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-1 p-4")}>
			<FileRow
				icon="/landing/icon-sq-mp4.svg"
				name="launch-video.mp4"
				highlighted
				meta="2.1 GB · v3 · no LFS needed"
			/>
			<FileRow
				icon="/landing/icon-sq-md.svg"
				name="launch-plan.md"
				meta={
					<>
						34 edits ·{" "}
						<span className="font-mono">
							<span className="text-success-border">+9</span>{" "}
							<span className="text-danger-border">−4</span>
						</span>{" "}
						today
					</>
				}
			/>
			<FileRow
				icon="/landing/icon-sq-csv.svg"
				name="pipeline.csv"
				meta={
					<>
						row-level diffs ·{" "}
						<span className="font-mono text-success-border">+12 rows</span>
					</>
				}
			/>
			<FileRow
				icon="/landing/icon-sq-pdf.svg"
				name="board-deck.pdf"
				meta="every version kept · v5"
			/>
			<FileRow
				icon="/landing/icon-sq-png.svg"
				name="logo-lockup.png"
				meta="compare versions side by side"
			/>
		</div>
	);
}

function FileRow({
	icon,
	name,
	meta,
	highlighted = false,
}: {
	icon: string;
	name: string;
	meta: ReactNode;
	highlighted?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-[11px] rounded-[9px] px-3 py-[11px]",
				highlighted && "bg-bg-hover",
			)}
		>
			<img className="size-[18px]" src={icon} alt="" />
			<span className="text-[13.5px] font-semibold text-fg">{name}</span>
			<span className="ml-auto text-right text-xs text-fg-subtle">{meta}</span>
		</div>
	);
}

function ProposalsVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-2.5 p-4")}>
			<div className="flex flex-col gap-2.5 rounded-xl border border-accent-border bg-accent-subtle px-4 py-3.5">
				<span className="flex flex-col gap-0.5">
					<span className="text-[13.5px] font-bold text-fg">
						Update refund policy to 30 days
					</span>
					<span className="text-xs text-accent">
						proposal on kb/refunds.md ·{" "}
						<span className="font-semibold text-accent">
							Jonas&apos;s ChatGPT
						</span>{" "}
						·{" "}
						<span className="font-mono">
							<span className="text-success-border">+4</span>{" "}
							<span className="text-danger-border">−4</span>
						</span>
					</span>
				</span>
				<span className="text-[13px] leading-[1.55] text-fg">
					<span className="rounded bg-diff-removed-subtle px-1 py-px text-diff-removed line-through decoration-diff-removed">
						within 14 days of purchase
					</span>{" "}
					<span className="rounded bg-diff-added-subtle px-1 py-px ring-1 ring-diff-added/30 ring-inset">
						within 30 days of purchase
					</span>
				</span>
				<span className="flex gap-2">
					<span className="rounded-lg bg-[image:var(--at-accent-gradient)] px-3.5 py-1.5 text-[12.5px] font-bold text-accent-on">
						Accept
					</span>
					<span className="rounded-lg border border-accent-border bg-panel px-3.5 py-1.5 text-[12.5px] font-semibold text-fg-muted">
						Reject
					</span>
				</span>
			</div>
			<div className="flex items-center gap-[9px] px-4 pt-0.5 pb-1 text-[12.5px] text-fg-faint">
				<CheckIcon size={13} />
				<span>
					<b className="text-fg-muted">Pricing one-pager v3</b> accepted by Mara
					· 2 hr ago
				</span>
			</div>
		</div>
	);
}

function ActivityVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col px-5 py-4")}>
			<div className="relative flex flex-col">
				<span className="absolute top-4 bottom-4 left-[3.75px] w-[1.5px] bg-border" />
				<ActivityRow
					iconSrc="/landing/claude-spark.svg"
					iconClass="bg-accent-subtle"
					who="Mara's Claude"
					verb="edited"
					file="gtm/launch-plan.md"
					time="just now"
					live
				/>
				<ActivityRow
					iconSrc="/landing/brand-openai.svg"
					iconClass="bg-bg-hover"
					who="Jonas's ChatGPT"
					verb="updated"
					file="sales/pipeline.csv"
					time="2 min ago"
					live
				/>
				<ActivityRow
					iconSrc="/landing/codex-icon.svg"
					iconClass="bg-overlay"
					iconSize="size-2.5"
					who="Codex"
					verb="uploaded"
					file="finance/board-deck.pdf"
					time="14 min ago"
				/>
				<ActivityRow
					iconSrc="/landing/claude-spark.svg"
					iconClass="bg-accent-subtle"
					who="Mara's Claude"
					verb="edited"
					file="kb/refunds.md"
					time="1 hr ago"
				/>
			</div>
		</div>
	);
}

function ActivityRow({
	iconSrc,
	iconClass,
	iconSize = "size-[11px]",
	who,
	verb,
	file,
	time,
	live = false,
}: {
	iconSrc: string;
	iconClass: string;
	iconSize?: string;
	who: string;
	verb: string;
	file: string;
	time: string;
	live?: boolean;
}) {
	return (
		<div className="flex items-center gap-3.5 px-1 py-2.5">
			<span className="relative z-[1] size-[9px] shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_var(--at-panel)]" />
			<span
				className={cn(
					"inline-flex size-5 shrink-0 items-center justify-center rounded-md",
					iconClass,
				)}
			>
				<img className={cn("object-contain", iconSize)} src={iconSrc} alt="" />
			</span>
			<span className="min-w-0 text-[13px] text-fg-muted">
				<b className="text-fg">{who}</b> {verb}{" "}
				<span className="rounded bg-bg-hover px-[5px] py-px font-mono text-xs">
					{file}
				</span>
			</span>
			<span className="ml-auto inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-subtle">
				{live ? <span className="size-[7px] rounded-full bg-success" /> : null}
				{time}
			</span>
		</div>
	);
}

function PermissionsVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-1 p-4")}>
			<PermissionRow name="gtm">
				<PermChip>Everyone · edit</PermChip>
			</PermissionRow>
			<PermissionRow name="sales">
				<PermChip>Sales team · edit</PermChip>
				<PermChip>Everyone · view</PermChip>
			</PermissionRow>
			<PermissionRow name="finance" highlighted>
				<PermChip variant="locked">
					<LockIcon />
					Finance only
				</PermChip>
				<PermChip>Mara approves</PermChip>
			</PermissionRow>
			<PermissionRow name="skills">
				<PermChip>Everyone · view</PermChip>
				<PermChip>proposals only</PermChip>
			</PermissionRow>
		</div>
	);
}

function PermissionRow({
	name,
	highlighted = false,
	children,
}: {
	name: string;
	highlighted?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-[11px] rounded-[9px] px-3 py-[11px]",
				highlighted && "bg-accent-subtle",
			)}
		>
			<img className="size-[18px]" src="/landing/icon-folder.svg" alt="" />
			<span className="text-[13.5px] font-semibold text-fg">{name}</span>
			<span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5">
				{children}
			</span>
		</div>
	);
}

function PermChip({
	children,
	variant = "default",
}: {
	children: ReactNode;
	variant?: "default" | "locked";
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-[5px] rounded-full border px-2.5 py-[3px] text-[11.5px] font-semibold whitespace-nowrap",
				variant === "locked"
					? "border-accent-border bg-panel text-accent"
					: "border-border bg-bg-hover text-fg-muted",
			)}
		>
			{children}
		</span>
	);
}

function InsightsVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-0.5 p-4")}>
			<div className="flex items-center justify-between px-3 pt-1 pb-2.5">
				<span className="text-[13.5px] font-bold text-fg">
					What agents read
				</span>
				<span className="text-xs text-fg-subtle">last 30 days</span>
			</div>
			<InsightRow
				icon="/landing/icon-sq-md.svg"
				name="skills/research/SKILL.md"
				percent={100}
				count="214"
			/>
			<InsightRow
				icon="/landing/icon-sq-md.svg"
				name="gtm/icp.md"
				percent={61}
				count="131"
			/>
			<InsightRow
				icon="/landing/icon-sq-csv.svg"
				name="sales/pipeline.csv"
				percent={42}
				count="89"
			/>
			<InsightRow
				icon="/landing/icon-sq-md.svg"
				name="ops/runbook.md"
				percent={26}
				count="56"
			/>
			<InsightRow
				icon="/landing/icon-sq-pdf.svg"
				name="brand/old-deck.pdf"
				percent={0}
				count="0"
				dead
			/>
		</div>
	);
}

function InsightRow({
	icon,
	name,
	percent,
	count,
	dead = false,
}: {
	icon: string;
	name: string;
	percent: number;
	count: string;
	dead?: boolean;
}) {
	return (
		<div className="flex items-center gap-[11px] px-3 py-[9px]">
			<img
				className={cn("size-[17px]", dead && "opacity-55 grayscale")}
				src={icon}
				alt=""
			/>
			<span
				className={cn(
					"w-[130px] shrink-0 truncate text-[13px] font-semibold sm:w-[210px]",
					dead ? "text-fg-faint" : "text-fg",
				)}
			>
				{name}
			</span>
			<span className="h-2 flex-1 overflow-hidden rounded-full bg-border">
				<span
					className="block h-full rounded-full bg-[linear-gradient(90deg,var(--at-link),var(--at-accent))]"
					style={{ width: `${percent}%` }}
				/>
			</span>
			<span
				className={cn(
					"w-9 shrink-0 text-right font-mono text-xs sm:w-[74px]",
					dead ? "text-fg-faint" : "text-fg-muted",
				)}
			>
				{count}
			</span>
		</div>
	);
}

function LockIcon({ size = 12 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--at-fg-subtle)"
			strokeWidth="2.2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="4" y="11" width="16" height="9" rx="2" />
			<path d="M8 11V7a4 4 0 018 0v4" />
		</svg>
	);
}

function RepoArea({
	path,
	title,
	body,
	Icon,
}: {
	path: string;
	title: string;
	body: string;
	Icon: LucideIcon;
}) {
	return (
		<div className="flex flex-col gap-2.5 rounded-2xl border border-fg/8 bg-bg p-6">
			<span className="inline-flex items-center gap-2.5">
				<span className="relative inline-flex size-8 shrink-0 items-center justify-center">
					<img
						className="absolute inset-0 size-full"
						src="/landing/icon-folder.svg"
						alt=""
					/>
					{/* Nudged below box center onto the folder's front panel. */}
					<Icon
						className="relative top-1 size-3 text-tag-blue"
						strokeWidth={2.4}
						aria-hidden="true"
					/>
				</span>
				<span className="font-mono text-[15px] font-bold text-accent">
					{path}
				</span>
			</span>
			<h3 className="m-0 text-[17px] font-bold text-fg">{title}</h3>
			<p className="m-0 text-sm leading-[1.6] text-fg-muted">{body}</p>
		</div>
	);
}

function CheckIcon({ size = 11 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--at-success)"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M20 6L9 17l-5-5" />
		</svg>
	);
}

/**
 * Previous general-angle hero copy, preserved for future reference. Swap this
 * back into the hero section of VsGithubPage to restore it.
 */
export function GeneralHeroCopy() {
	return (
		<>
			<h1 className="m-0 max-w-[1060px] text-[clamp(2.5rem,6vw,4rem)] leading-[1.08] font-bold tracking-[-.035em] text-balance">
				Put your company
				<br />
				into a repository
			</h1>
			<p className="m-0 max-w-[680px] text-[21px] leading-[1.55] text-fg-muted text-pretty">
				Your code already lives in one. LixRay is the repository for everything
				else: GTM, ops, sales, finance. Built for every file format and every
				person, not just engineers.
			</p>
		</>
	);
}
