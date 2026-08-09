import {
	ArrowRight,
	BookOpen,
	DollarSign,
	type LucideIcon,
	Sparkles,
	TrendingUp,
	Workflow,
	Wrench,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SiteHeader, useWorkspaceCta } from "~/components/site-header";
import { cn } from "~/lib/utils";

const primaryButton =
	"inline-flex items-center justify-center rounded-xl bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-7 py-[15px] text-[17px] font-bold whitespace-nowrap text-white no-underline shadow-[0_10px_26px_rgba(232,89,12,.35),inset_0_1px_0_rgba(255,255,255,.28)] transition hover:brightness-105";
const secondaryButton =
	"inline-flex items-center justify-center rounded-xl border border-[#1c1917]/12 bg-white px-6 py-3.5 text-base font-semibold whitespace-nowrap text-[#1c1917] no-underline transition hover:border-[#1c1917]/25";
const visualCard =
	"rounded-2xl border border-[#1c1917]/8 bg-white shadow-[0_24px_60px_rgba(28,25,23,.08)]";

export function LandingPage() {
	const { authLoaded, user, workspaceState, workspaceTo } = useWorkspaceCta();
	const [autoOpenLoaded, setAutoOpenLoaded] = useState(false);
	const [autoOpenEnabled, setAutoOpenEnabled] = useState(false);
	const [openPromptDismissed, setOpenPromptDismissed] = useState(false);
	const heroCtaLabel = user ? "Open LixRay" : "Create your repo for free";

	useEffect(() => {
		if (!authLoaded) return;
		if (!user) {
			setAutoOpenEnabled(false);
			setAutoOpenLoaded(true);
			return;
		}
		setAutoOpenEnabled(
			window.localStorage.getItem(autoOpenStorageKey(user.id)) === "true",
		);
		setAutoOpenLoaded(true);
	}, [authLoaded, user]);

	useEffect(() => {
		if (
			!user ||
			!autoOpenLoaded ||
			!autoOpenEnabled ||
			!workspaceState.isLoaded
		) {
			return;
		}
		window.location.replace(workspaceTo);
	}, [
		autoOpenEnabled,
		autoOpenLoaded,
		user,
		workspaceState.isLoaded,
		workspaceTo,
	]);

	const alwaysOpenLixRay = () => {
		if (!user) return;
		window.localStorage.setItem(autoOpenStorageKey(user.id), "true");
		setAutoOpenEnabled(true);
		window.location.assign(workspaceTo);
	};

	return (
		<div className="min-h-screen bg-white font-sans text-[#1c1917] antialiased">
			<SiteHeader>
				{user &&
				autoOpenLoaded &&
				workspaceState.isLoaded &&
				!autoOpenEnabled &&
				!openPromptDismissed ? (
					<div
						className="absolute top-[78px] right-5 grid w-[min(330px,calc(100vw-40px))] gap-2.5 rounded-[18px] border border-black/8 bg-white py-5 pr-12 pl-6 text-base shadow-[0_18px_48px_rgba(74,40,19,.18)] sm:right-14"
						role="status"
					>
						<button
							className="absolute top-4 right-4 grid cursor-pointer place-items-center border-0 bg-transparent p-1 text-stone-400"
							type="button"
							aria-label="Dismiss"
							onClick={() => setOpenPromptDismissed(true)}
						>
							<X className="size-5" aria-hidden="true" />
						</button>
						<span className="font-semibold">Skip this page next time?</span>
						<button
							className="inline-flex cursor-pointer items-center gap-2 justify-self-start border-0 bg-transparent p-0 font-bold text-[#e8590c]"
							type="button"
							onClick={alwaysOpenLixRay}
						>
							Always open LixRay{" "}
							<ArrowRight className="size-4" aria-hidden="true" />
						</button>
					</div>
				) : null}
			</SiteHeader>

			<main>
				<section
					className="flex flex-col items-center gap-6 px-5 pt-10 text-center sm:px-14 sm:pt-[90px]"
					aria-labelledby="landing-title"
				>
					<h1
						className="m-0 max-w-[1060px] text-[clamp(2.5rem,6vw,4rem)] leading-[1.08] font-bold tracking-[-.035em] text-balance"
						id="landing-title"
					>
						A repository for your
						<br />
						whole company
					</h1>
					<p className="m-0 max-w-[680px] text-[21px] leading-[1.55] text-[#57534e] text-pretty">
						Your codebase already lives in one. LixRay is the repository for
						everything else: GTM, operations, sales, finance. Built for every
						file format and every person, not just engineers.
					</p>
					<div className="mt-3 flex flex-wrap items-center justify-center gap-3">
						<a className={primaryButton} href={workspaceTo}>
							{heroCtaLabel}
						</a>
						{user ? null : (
							<a className={secondaryButton} href="/sign-in">
								Sign in
							</a>
						)}
					</div>
					<div className="mt-0.5 flex flex-wrap items-center justify-center gap-2.5 text-sm text-[#8a8178]">
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
					className="border-t border-[#1c1917]/7 bg-white"
					aria-labelledby="git-wall-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-[22px] px-5 py-20 sm:px-14 sm:py-[110px]">
						<h2
							className="m-0 text-[clamp(2rem,4.5vw,2.5rem)] leading-[1.12] font-bold tracking-[-.03em] text-balance"
							id="git-wall-title"
						>
							Git works for code.
							<br />
							Not for the rest of your company.
						</h2>
						<p className="m-0 max-w-[640px] text-[17px] leading-[1.6] text-[#57534e] text-pretty">
							Putting work in a repository is why engineering has one source of
							truth, review before changes land, and agents you can safely let
							write. Teams try to extend it: markdown in the repo, a{" "}
							<span className="rounded-[5px] bg-[#f7f3ed] px-1.5 py-px font-mono text-[15px]">
								docs/
							</span>{" "}
							folder, LFS for the big files. They hit the same three walls.
						</p>
						<div className="mt-[26px] grid gap-6 sm:grid-cols-2">
							<div className="flex flex-col gap-3 rounded-2xl border border-[#1c1917]/8 bg-[#fbf6f0] p-7">
								<span className="inline-flex items-center gap-[7px]">
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
									<img
										className="size-[19px] opacity-55 grayscale"
										src="/landing/icon-sq-csv.svg"
										alt=""
									/>
								</span>
								<h3 className="m-0 mt-1.5 text-xl font-bold tracking-[-.01em]">
									Git is designed for source code
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-[#57534e] text-pretty">
									Git stores any file, but only text is first-class. History for
									PDFs, spreadsheets, decks, and images means wiring up custom
									diff and merge drivers — nothing works out of the box. LFS is
									a workaround, not an answer.
								</p>
							</div>
							<div className="flex flex-col gap-3 rounded-2xl border border-[#1c1917]/8 bg-[#fbf6f0] p-7">
								<span className="inline-flex items-center gap-1.5 font-mono text-xs text-[#8a8178]">
									<span className="rounded-[5px] bg-[#efe9e1] px-2 py-[3px]">
										clone
									</span>
									<span className="rounded-[5px] bg-[#efe9e1] px-2 py-[3px]">
										rebase
									</span>
									<span className="rounded-[5px] bg-[#efe9e1] px-2 py-[3px]">
										merge conflict
									</span>
								</span>
								<h3 className="m-0 mt-1.5 text-xl font-bold tracking-[-.01em]">
									Git is too complicated for non-developers
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-[#57534e] text-pretty">
									Clone, branch, stage, resolve conflicts. Your GTM lead is not
									going to do that and should not have to. The moment
									non-developers can&apos;t participate, the repo stops being
									the source of truth.
								</p>
							</div>
						</div>
						<div className="mt-6 flex flex-col items-start gap-8 rounded-2xl border border-[#1c1917]/8 bg-[#fbf6f0] px-8 py-7 lg:flex-row lg:items-center lg:gap-12">
							<div className="flex max-w-[340px] shrink-0 flex-col gap-3">
								<h3 className="m-0 text-xl font-bold tracking-[-.01em]">
									Git&apos;s workflow is built for async engineering
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-[#57534e] text-pretty">
									The standard flow takes a detour: branch off, open a pull
									request, wait for review and CI, merge back. Non-developers
									just need to make a change and move on.
								</p>
							</div>
							<div className="flex w-full flex-1 flex-col gap-1.5">
								<div className="flex items-center gap-3.5">
									<span className="w-[110px] shrink-0 text-[11px] leading-[1.5] font-bold tracking-[.06em] text-[#8a8178] uppercase">
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
											<path d="M0 62 H400" stroke="#E3DACC" strokeWidth="1.5" />
											<path
												d="M56 62 C 76 62, 76 26, 100 26 H 302 C 326 26, 326 62, 346 62"
												stroke="#D9CFC0"
												strokeWidth="1.5"
												strokeDasharray="4 4"
												fill="none"
											/>
											<circle cx="56" cy="62" r="4" fill="#1C1917" />
											<circle cx="346" cy="62" r="4" fill="#C2410C" />
										</svg>
										<span className="absolute bottom-0.5 left-[3%] inline-flex items-center rounded-[5px] bg-[#efe9e1] px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-[#57534e]">
											create branch
										</span>
										<span className="absolute top-1.5 left-[30%] inline-flex items-center rounded-[5px] bg-[#efe9e1] px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-[#57534e]">
											open PR
										</span>
										<span className="absolute top-1.5 left-[58%] inline-flex items-center rounded-[5px] bg-[#efe9e1] px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-[#57534e]">
											wait for CI
										</span>
										<span className="absolute right-0 bottom-0.5 inline-flex items-center rounded-[5px] bg-[#1c1917] px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-[#fbf6f0]">
											merged · next day
										</span>
									</div>
								</div>
								<div className="flex items-start gap-3.5">
									<span className="w-[110px] shrink-0 text-[11px] leading-[1.5] font-bold tracking-[.06em] text-[#c2410c] uppercase">
										Non-devs want
									</span>
									<div className="relative h-12 flex-1">
										<span className="absolute top-[18px] right-0 left-0 h-[1.5px] bg-[#e3dacc]" />
										<span className="absolute top-[18px] left-[10%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#c2410c]" />
										<span className="absolute top-[18px] left-[40%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#c2410c]" />
										<span className="absolute top-[18px] left-[68%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#c2410c]" />
										<span className="absolute top-[30px] left-[10%] -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-[#9a6b4f]">
											edit plan
										</span>
										<span className="absolute top-[30px] left-[40%] -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-[#9a6b4f]">
											update csv
										</span>
										<span className="absolute top-[30px] left-[68%] -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-[#9a6b4f]">
											fix pricing
										</span>
										<span className="absolute top-[18px] right-0 inline-flex -translate-y-1/2 items-center rounded-[5px] border border-[#f3d8be] bg-[#fbefe4] px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-[#9a6b4f]">
											done
										</span>
									</div>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section
					className="border-t border-[#1c1917]/7 bg-[#fbf6f0]"
					aria-labelledby="offers-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-24 px-5 py-24 sm:px-14 sm:py-[120px] lg:gap-[120px]">
						<div className="-mb-14 flex flex-col items-center text-center lg:-mb-[70px]">
							<h2
								className="m-0 text-[clamp(2rem,4.5vw,2.375rem)] leading-[1.12] font-bold tracking-[-.03em]"
								id="offers-title"
							>
								What LixRay offers
							</h2>
						</div>
						<Band
							label="Beyond text files"
							title="Every file format is first-class"
							body="One history for the 2.1 GB launch video, the board PDF, the pipeline CSV, and the launch plan. Prose diffs as prose, spreadsheets diff row by row, large assets keep every version. No size limits, no LFS setup."
							visual={<FileFormatsVisual />}
						/>
						<Band
							reverse
							label="Suggestions instead of pull requests"
							title="Understandable by non-developers"
							body="Suggest a change, the owner accepts or rejects it. Checkpoints instead of commits. No branching to learn."
							visual={<ProposalsVisual />}
						/>
						<Band
							label="Branching optional"
							title="Real-time support"
							body="Non-developers want a simple mental model: make a change, it lands in one linear history. Branching and async review are supported for workflows that need them."
							visual={<ActivityVisual />}
						/>
						<Band
							reverse
							soon
							label="Access control"
							title="Permissions"
							body="Who can see, who can edit, who approves. Git hosts control who can push, not who can see. There's no “finance can read this folder, sales can't.”"
							visual={<PermissionsVisual />}
						/>
						<Band
							soon
							label="Visibility"
							title="Insights"
							body="See which files and skills your agents actually read and use. Know what context matters and what is dead weight."
							visual={<InsightsVisual />}
						/>
					</div>
				</section>

				<section
					className="border-t border-[#1c1917]/7 bg-white"
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
						</div>
						<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
							<RepoArea
								path="skills/"
								Icon={Sparkles}
								body="The SKILL.md files and prompts your agents run on. Diff each revision; roll back the edit that broke behavior."
							/>
							<RepoArea
								path="automations/"
								Icon={Workflow}
								body="The recurring jobs your agents run on a schedule: the Monday pipeline summary, the weekly knowledge-base check. Versioned and reviewable like everything else."
							/>
							<RepoArea
								path="sales/"
								Icon={TrendingUp}
								body="The pipeline CSV, call notes, proposals. An agent updates the pipeline after every call. You review the diff."
							/>
							<RepoArea
								path="operations/"
								Icon={Wrench}
								body='Runbooks, vendor lists, onboarding checklists. The files that answer "how do we do this here."'
							/>
							<RepoArea
								path="finance/"
								Icon={DollarSign}
								body="The budget, the model, board decks. Every version kept; every change attributed."
							/>
							<RepoArea
								path="knowledge-base/"
								Icon={BookOpen}
								body="Policies, FAQs, product facts. The answers your team and agents rely on, kept current and trustworthy."
							/>
						</div>
						<div className="flex items-center gap-[18px]">
							<span className="flex-1 border-t-[1.5px] border-dashed border-[#d9cfc0]" />
							<span className="text-sm font-bold whitespace-nowrap text-[#8a8178]">
								What does not go in
							</span>
							<span className="flex-1 border-t-[1.5px] border-dashed border-[#d9cfc0]" />
						</div>
						<div className="flex flex-col items-start gap-6 rounded-[14px] border border-[#1c1917]/6 bg-[#f7f3ed] px-7 py-6 lg:flex-row lg:items-center lg:gap-9">
							<p className="m-0 max-w-[340px] text-base leading-[1.55] text-[#292524] text-pretty">
								<b>Your codebase stays in GitHub.</b> LixRay is for data outside
								your codebase.
							</p>
							<div className="flex flex-1 flex-wrap items-center justify-center gap-4 lg:flex-nowrap">
								<div className="flex shrink-0 flex-col gap-[11px] rounded-xl border border-[#1c1917]/10 bg-white px-[18px] py-4">
									<span className="inline-flex items-center gap-2">
										<img
											className="size-4"
											src="/landing/brand-github.svg"
											alt="GitHub"
										/>
										<span className="font-mono text-[12.5px] font-bold text-[#1c1917]">
											github.com/acme
										</span>
									</span>
									<span className="inline-flex items-center gap-1.5">
										<RepoChip variant="github">frontend</RepoChip>
										<RepoChip variant="github">backend</RepoChip>
									</span>
									<span className="text-[11.5px] font-semibold text-[#8a8178]">
										codebase
									</span>
								</div>
								<span className="text-lg font-semibold text-[#c9c2b8]">+</span>
								<div className="flex flex-col gap-[11px] rounded-xl border border-[#f3d8be] bg-[#fbefe4] px-[18px] py-4">
									<span className="inline-flex items-center gap-2">
										<img
											className="size-4"
											src="/landing/lixray-glyph.svg"
											alt="LixRay"
										/>
										<span className="font-mono text-[12.5px] font-bold text-[#1c1917]">
											lixray.com/@acme/company
										</span>
									</span>
									<span className="inline-flex flex-wrap items-center gap-1.5">
										<RepoChip>gtm</RepoChip>
										<RepoChip>sales</RepoChip>
										<RepoChip>operations</RepoChip>
										<RepoChip>finance</RepoChip>
										<RepoChip>skills</RepoChip>
									</span>
									<span className="text-[11.5px] font-semibold text-[#c2410c]">
										everything else
									</span>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section className="flex flex-col items-center gap-[22px] border-t border-[#1c1917]/7 bg-white px-5 py-24 text-center sm:py-[120px]">
					<h2 className="m-0 max-w-[720px] text-[clamp(2rem,4.5vw,2.625rem)] leading-[1.1] font-bold tracking-[-.03em] text-balance">
						A repository for your whole company
					</h2>
					<a className={cn(primaryButton, "mt-1")} href={workspaceTo}>
						{heroCtaLabel}
					</a>
				</section>
			</main>

			<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[#1c1917]/7 px-5 py-6 text-sm text-[#8a8178] sm:px-14">
				<span className="inline-flex items-center gap-2">
					<img className="size-4" src="/lixray-mark.svg" alt="" />
					<span className="font-semibold text-[#57534e]">LixRay</span>
				</span>
				<span>© 2026 Opral</span>
				<a
					className="font-semibold text-[#57534e] no-underline"
					href="https://github.com/opral"
					target="_blank"
					rel="noreferrer"
				>
					GitHub ↗
				</a>
			</footer>
		</div>
	);
}

function autoOpenStorageKey(userId: string) {
	return `lixray.landing.auto-open:${userId}`;
}

function HeroVisual() {
	return (
		<div
			className="flex flex-col items-center justify-center gap-7 lg:flex-row lg:gap-0"
			aria-label="Agents in ChatGPT, Slack, Claude, and the terminal all working against one LixRay repository"
		>
			<div className="flex w-[300px] shrink-0 flex-col gap-7">
				<div className="overflow-hidden rounded-[14px] border border-[#1c1917]/18 bg-white shadow-[0_18px_44px_rgba(28,25,23,.1)]">
					<div className="flex items-center gap-2 bg-[#1c1917] px-3.5 py-2.5">
						<img
							className="size-3.5 object-contain brightness-0 invert"
							src="/landing/brand-openai.svg"
							alt=""
						/>
						<span className="text-[12.5px] font-bold text-white">ChatGPT</span>
						<span className="ml-auto text-[11px] text-[#a8a29e]">Jonas</span>
					</div>
					<div className="flex flex-col gap-2 px-3.5 py-3">
						<div className="max-w-[230px] self-end rounded-[14px] bg-[#f0f0f0] px-3 py-[7px] text-[12.5px] leading-[1.45] text-[#1f1f1f]">
							Move Northwind to Negotiation, $48k
						</div>
						<span className="inline-flex items-center gap-1.5 self-start rounded-full border border-[#e5e5e5] bg-[#f7f7f8] px-2.5 py-1 text-[11.5px] text-[#444444]">
							<CheckIcon size={10} />
							Edited pipeline.csv
						</span>
					</div>
				</div>
				<div className="overflow-hidden rounded-[14px] border border-[#1c1917]/10 bg-white shadow-[0_18px_44px_rgba(28,25,23,.1)]">
					<div className="flex items-center gap-2 border-b border-[#f0ede8] px-3.5 py-2.5">
						<img
							className="size-3.5"
							src="/landing/brand-slack.svg"
							alt="Slack"
						/>
						<span className="text-[13px] font-extrabold text-[#1d1c1d]">
							#go-to-market
						</span>
						<span className="ml-auto text-[11px] text-[#a8a29e]">
							24 members
						</span>
					</div>
					<div className="flex flex-col gap-3 px-3.5 py-3">
						<div className="flex gap-[9px]">
							<span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[#1c1917] text-[11px] font-bold text-[#fbf6f0]">
								M
							</span>
							<span className="flex flex-col gap-0.5">
								<span className="text-xs">
									<b className="text-[#1d1c1d]">Mara</b>{" "}
									<span className="text-[11px] text-[#a8a29e]">2:03 PM</span>
								</span>
								<span className="text-[12.5px] leading-[1.45] text-[#1f1f1f]">
									<span className="rounded bg-[#e8f5fa] px-[3px] font-semibold text-[#1264a3]">
										@Claude
									</span>{" "}
									update the runbook with the new on-call rotation
								</span>
							</span>
						</div>
						<div className="flex gap-[9px]">
							<span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[#fdf1e7]">
								<img
									className="size-[13px]"
									src="/landing/claude-spark.svg"
									alt=""
								/>
							</span>
							<span className="flex flex-col gap-0.5">
								<span className="text-xs">
									<b className="text-[#1d1c1d]">Claude</b>{" "}
									<span className="rounded-[3px] bg-[#f0f0f0] px-1 py-px text-[9.5px] font-bold text-[#7a7a7a]">
										APP
									</span>{" "}
									<span className="text-[11px] text-[#a8a29e]">2:04 PM</span>
								</span>
								<span className="text-[12.5px] leading-[1.45] text-[#1f1f1f]">
									Done. Proposed an edit to{" "}
									<span className="rounded bg-[#f7f3ed] px-1 font-mono text-[11.5px]">
										operations/runbook.md
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
					stroke="#E3DACC"
					strokeWidth="1.5"
				/>
				<path
					d="M0 250 C 44 250, 36 160, 80 160"
					stroke="#E3DACC"
					strokeWidth="1.5"
				/>
				<circle cx="80" cy="160" r="3" fill="#C2410C" />
			</svg>
			<div className="flex w-[320px] shrink-0 flex-col gap-px rounded-2xl border border-[#1c1917]/10 bg-white px-3 py-[18px] text-[13px] text-[#292524] shadow-[0_30px_80px_rgba(28,25,23,.14)]">
				<span className="mx-1 mb-3 flex rounded-lg border border-[#ece8e2] bg-[#f4f2ef] px-3 py-[7px] font-mono text-xs text-[#8a8178]">
					<span>
						lixray.com/<b className="text-[#1c1917]">@acme/company</b>
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
							<span className="text-[#15803d]">+12</span>{" "}
							<span className="text-[#b91c1c]">−3</span>
						</span>
					}
				>
					pipeline.csv
				</TreeFile>
				<TreeFile icon="/landing/icon-sq-md.svg">call-notes.md</TreeFile>
				<TreeFolder>operations</TreeFolder>
				<TreeFile
					icon="/landing/icon-sq-md.svg"
					highlighted
					meta={
						<span className="font-mono text-[11.5px]">
							<span className="text-[#15803d]">+3</span>{" "}
							<span className="text-[#b91c1c]">−3</span>
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
						<span className="font-mono text-[11.5px] text-[#8a8178]">
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
					stroke="#E3DACC"
					strokeWidth="1.5"
				/>
				<path
					d="M80 250 C 36 250, 44 160, 0 160"
					stroke="#E3DACC"
					strokeWidth="1.5"
				/>
				<circle cx="0" cy="160" r="3" fill="#C2410C" />
			</svg>
			<div className="flex w-[300px] shrink-0 flex-col gap-7">
				<div className="overflow-hidden rounded-[14px] border border-[#f3d8be] bg-[#fbf5ea] shadow-[0_18px_44px_rgba(28,25,23,.1)]">
					<div className="flex items-center gap-2 px-3.5 py-2.5">
						<img className="size-3.5" src="/landing/claude-spark.svg" alt="" />
						<span className="text-[12.5px] font-bold text-[#c2410c]">
							Claude
						</span>
						<span className="ml-auto text-[11px] text-[#c88a5f]">Mara</span>
					</div>
					<div className="flex flex-col gap-2 px-3.5 pb-3">
						<div className="max-w-[230px] self-end rounded-[14px_14px_4px_14px] bg-[#efe3cc] px-3 py-[7px] text-[12.5px] leading-[1.45] text-[#292524]">
							Rewrite launch pricing to usage-based
						</div>
						<span className="inline-flex items-center gap-1.5 self-start rounded-full border border-[#ebdcc3] bg-white px-2.5 py-1 text-[11.5px] text-[#8a6a4c]">
							<CheckIcon size={10} />
							Proposed edit to launch-plan.md
						</span>
					</div>
				</div>
				<div className="flex flex-col overflow-hidden rounded-[14px] bg-[#1c1917] shadow-[0_18px_44px_rgba(28,25,23,.2)]">
					<div className="flex items-center gap-1.5 bg-[#292524] px-3 py-[9px]">
						<span className="size-2.5 rounded-full bg-[#ff5f57]" />
						<span className="size-2.5 rounded-full bg-[#febc2e]" />
						<span className="size-2.5 rounded-full bg-[#28c840]" />
						<span className="flex-1 pr-[42px] text-center text-[11px] text-[#a8a29e]">
							Terminal
						</span>
					</div>
					<div className="flex flex-col gap-[7px] px-4 pt-3 pb-3.5 font-mono text-xs leading-[1.5]">
						<span className="text-[#d6d3d1]">
							<span className="text-[#78716c]">$</span> codex &quot;new board
							deck version&quot;
						</span>
						<span className="text-[#86efac]">
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
				highlighted && "rounded-[7px] bg-[#fbefe4] font-semibold",
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
				"inline-flex items-center gap-[5px] rounded-md border px-[9px] py-1 font-mono text-[11px] text-[#57534e]",
				variant === "github"
					? "border-[#ececec] bg-[#f7f7f8]"
					: "border-[#f0dfc8] bg-white",
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
				<span className="text-sm font-bold tracking-[.02em] text-[#c2410c]">
					{label}
				</span>
				<div className="flex items-center gap-3">
					<h3 className="m-0 text-[30px] leading-[1.18] font-bold tracking-[-.02em]">
						{title}
					</h3>
					{soon ? (
						<span className="rounded-full border border-[#f3d8be] bg-[#fbefe4] px-2.5 py-[3px] text-[10.5px] font-bold tracking-[.06em] text-[#c2410c] uppercase">
							Soon
						</span>
					) : null}
				</div>
				<p className="m-0 text-[16.5px] leading-[1.6] text-[#57534e] text-pretty">
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
							<span className="text-[#15803d]">+9</span>{" "}
							<span className="text-[#b91c1c]">−4</span>
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
						<span className="font-mono text-[#15803d]">+12 rows</span>
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
				highlighted && "bg-[#f7f3ed]",
			)}
		>
			<img className="size-[18px]" src={icon} alt="" />
			<span className="text-[13.5px] font-semibold text-[#1c1917]">{name}</span>
			<span className="ml-auto text-right text-xs text-[#8a8178]">{meta}</span>
		</div>
	);
}

function ProposalsVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-2.5 p-4")}>
			<div className="flex flex-col gap-2.5 rounded-xl border border-[#f3d8be] bg-[#fbefe4] px-4 py-3.5">
				<span className="flex flex-col gap-0.5">
					<span className="text-[13.5px] font-bold text-[#1c1917]">
						Update refund policy to 30 days
					</span>
					<span className="text-xs text-[#9a6b4f]">
						proposal on kb/refunds.md ·{" "}
						<span className="font-semibold text-[#c2410c]">
							Jonas&apos;s ChatGPT
						</span>{" "}
						·{" "}
						<span className="font-mono">
							<span className="text-[#15803d]">+4</span>{" "}
							<span className="text-[#b91c1c]">−4</span>
						</span>
					</span>
				</span>
				<span className="text-[13px] leading-[1.55] text-[#292524]">
					<span className="rounded bg-[#fee2e2] px-1 py-px text-[#8a5050] line-through decoration-[#dc8181]">
						within 14 days of purchase
					</span>{" "}
					<span className="rounded bg-[#dcfce7] px-1 py-px shadow-[inset_0_0_0_1px_#bbe7c9]">
						within 30 days of purchase
					</span>
				</span>
				<span className="flex gap-2">
					<span className="rounded-lg bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-3.5 py-1.5 text-[12.5px] font-bold text-white">
						Accept
					</span>
					<span className="rounded-lg border border-[#ebdcc7] bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-[#44403c]">
						Reject
					</span>
				</span>
			</div>
			<div className="flex items-center gap-[9px] px-4 pt-0.5 pb-1 text-[12.5px] text-[#a8a29e]">
				<CheckIcon size={13} />
				<span>
					<b className="text-[#57534e]">Pricing one-pager v3</b> accepted by
					Mara · 2 hr ago
				</span>
			</div>
		</div>
	);
}

function ActivityVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col px-5 py-4")}>
			<div className="relative flex flex-col">
				<span className="absolute top-4 bottom-4 left-[3.75px] w-[1.5px] bg-[#ede7dd]" />
				<ActivityRow
					iconSrc="/landing/claude-spark.svg"
					iconClass="bg-[#fdf1e7]"
					who="Mara's Claude"
					verb="edited"
					file="gtm/launch-plan.md"
					time="just now"
					live
				/>
				<ActivityRow
					iconSrc="/landing/brand-openai.svg"
					iconClass="bg-[#f1f0ee]"
					who="Jonas's ChatGPT"
					verb="updated"
					file="sales/pipeline.csv"
					time="2 min ago"
					live
				/>
				<ActivityRow
					iconSrc="/landing/codex-icon.svg"
					iconClass="bg-[#1c1917]"
					iconSize="size-2.5"
					who="Codex"
					verb="uploaded"
					file="finance/board-deck.pdf"
					time="14 min ago"
				/>
				<ActivityRow
					iconSrc="/landing/claude-spark.svg"
					iconClass="bg-[#fdf1e7]"
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
			<span className="relative z-[1] size-[9px] shrink-0 rounded-full bg-[#c2410c] shadow-[0_0_0_3px_#ffffff]" />
			<span
				className={cn(
					"inline-flex size-5 shrink-0 items-center justify-center rounded-md",
					iconClass,
				)}
			>
				<img className={cn("object-contain", iconSize)} src={iconSrc} alt="" />
			</span>
			<span className="min-w-0 text-[13px] text-[#44403c]">
				<b className="text-[#1c1917]">{who}</b> {verb}{" "}
				<span className="rounded bg-[#f7f3ed] px-[5px] py-px font-mono text-xs">
					{file}
				</span>
			</span>
			<span className="ml-auto inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-[#8a8178]">
				{live ? (
					<span className="size-[7px] rounded-full bg-[#19a463]" />
				) : null}
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
				highlighted && "bg-[#fbefe4]",
			)}
		>
			<img className="size-[18px]" src="/landing/icon-folder.svg" alt="" />
			<span className="text-[13.5px] font-semibold text-[#1c1917]">{name}</span>
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
					? "border-[#f3d8be] bg-white text-[#9a6b4f]"
					: "border-[#ece8e2] bg-[#f7f3ed] text-[#57534e]",
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
				<span className="text-[13.5px] font-bold text-[#1c1917]">
					What agents read
				</span>
				<span className="text-xs text-[#8a8178]">last 30 days</span>
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
				name="operations/runbook.md"
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
					dead ? "text-[#a8a29e]" : "text-[#1c1917]",
				)}
			>
				{name}
			</span>
			<span className="h-2 flex-1 overflow-hidden rounded-full bg-[#f0ede8]">
				<span
					className="block h-full rounded-full bg-[linear-gradient(90deg,#F97316,#C2410C)]"
					style={{ width: `${percent}%` }}
				/>
			</span>
			<span
				className={cn(
					"w-9 shrink-0 text-right font-mono text-xs sm:w-[74px]",
					dead ? "text-[#a8a29e]" : "text-[#57534e]",
				)}
			>
				{count}
			</span>
		</div>
	);
}

function LockIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#8A8178"
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
	body,
	Icon,
}: {
	path: string;
	body: string;
	Icon: LucideIcon;
}) {
	return (
		<div className="flex flex-col gap-3 rounded-2xl border border-[#1c1917]/8 bg-[#fbf6f0] p-6">
			<h3 className="m-0 inline-flex items-center gap-2.5">
				<span className="relative inline-flex size-8 shrink-0 items-center justify-center">
					<img
						className="absolute inset-0 size-full"
						src="/landing/icon-folder.svg"
						alt=""
					/>
					{/* Nudged below box center onto the folder's front panel. */}
					<Icon
						className="relative top-1 size-3 text-[#dbeafe]"
						strokeWidth={2.4}
						aria-hidden="true"
					/>
				</span>
				<span className="font-mono text-[15px] font-bold text-[#1c1917]">
					{path}
				</span>
			</h3>
			<p className="m-0 text-sm leading-[1.6] text-[#57534e]">{body}</p>
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
			stroke="#19A463"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M20 6L9 17l-5-5" />
		</svg>
	);
}
