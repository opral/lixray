import { ArrowRight, X } from "lucide-react";
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
		<div className="min-h-screen bg-[#fbf6f0] font-sans text-[#1c1917] antialiased">
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
						Put your company
						<br />
						into a repository
					</h1>
					<p className="m-0 max-w-[680px] text-[21px] leading-[1.55] text-[#57534e] text-pretty">
						Your code already lives in one. LixRay is the repository for
						everything else: GTM, ops, sales, finance. Built for every file
						format and every person, not just engineers.
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
							truth, real review, and agents that actually ship. Teams try to
							extend it: markdown in the repo, a{" "}
							<span className="rounded-[5px] bg-[#f7f3ed] px-1.5 py-px font-mono text-[15px]">
								docs/
							</span>{" "}
							folder, LFS for the big files. They hit the same two walls.
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
									Text diffs cleanly. Everything else is an opaque blob: PDFs,
									spreadsheets, decks, images. Stored, but nothing to review or
									compare. LFS is a workaround, not an answer.
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
									Git is designed for engineers
								</h3>
								<p className="m-0 text-[15.5px] leading-[1.6] text-[#57534e] text-pretty">
									Clone, branch, stage, resolve conflicts. Your GTM lead is not
									going to do that and should not have to. The moment
									non-engineers can&apos;t participate, the repo stops being the
									source of truth.
								</p>
							</div>
						</div>
						<div className="mt-[26px] flex flex-col items-start gap-6 rounded-[14px] border border-[#1c1917]/6 bg-[#f7f3ed] px-7 py-6 lg:flex-row lg:items-center lg:gap-9">
							<p className="m-0 max-w-[340px] text-base leading-[1.55] text-[#292524] text-pretty">
								<b>Your code stays in GitHub.</b> LixRay is for the repos that
								are not code.
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
										code
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
										<RepoChip>ops</RepoChip>
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

				<section
					className="border-t border-[#1c1917]/7"
					aria-label="What LixRay does"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-24 px-5 py-24 sm:px-14 sm:py-[120px] lg:gap-[120px]">
						<Band
							label="Beyond text files"
							title="Every file format is first-class"
							body="One history for the launch plan, the pipeline CSV, the board PDF, and the 2GB launch video. Prose diffs as prose, spreadsheets diff row by row, large assets keep every version. No size limits, no LFS setup."
							visual={<FileFormatsVisual />}
						/>
						<Band
							reverse
							label="Review without git"
							title="Proposals instead of pull requests"
							body="Anyone, or anyone's agent, can propose a change to a file. The owner sees exactly what changed and approves or declines. The rigor of a PR with no branches to manage."
							visual={<ProposalsVisual />}
						/>
						<Band
							label="Agent-native"
							title="All your agents share the same context"
							body="Connect Claude, ChatGPT, Gemini, or Codex over MCP. They all read and write the same repo. No pasting context into chats. What one agent changes, the next one knows."
							visual={<AgentsVisual />}
						/>
						<Band
							reverse
							label="Company history"
							title="Historical context to make better decisions in the future"
							body="Decisions live in files, and files have history. The file says what you do. The history says what you tried and why you stopped. When someone asks why, months later, the answer is already there. For people and for agents."
							visual={<HistoryVisual />}
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
							<p className="m-0 max-w-[560px] text-[17px] leading-[1.55] text-[#57534e] text-pretty">
								Everything a 5–20 person startup runs on that isn&apos;t code.
							</p>
						</div>
						<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
							<RepoArea
								path="skills/"
								title="Skills"
								body="The SKILL.md files and prompts your agents run on. Diff each revision; roll back the edit that broke behavior."
							/>
							<RepoArea
								path="gtm/"
								title="Go-to-market"
								body="Launch plans, messaging, positioning docs, the pricing one-pager. Agents keep them consistent with each other."
							/>
							<RepoArea
								path="sales/"
								title="Sales"
								body="The pipeline CSV, call notes, proposals. An agent updates the pipeline after every call. You review the diff."
							/>
							<RepoArea
								path="ops/"
								title="Operations"
								body='Runbooks, vendor lists, onboarding checklists. The files that answer "how do we do this here."'
							/>
							<RepoArea
								path="finance/"
								title="Finance"
								body="The budget, the model, board decks. Every version kept; every change attributed."
							/>
							<RepoArea
								path="kb/"
								title="Knowledge base"
								body="Policies, FAQs, product facts. The answers your team and agents rely on, kept current and trustworthy."
							/>
						</div>
					</div>
				</section>

				<section className="flex flex-col items-center gap-[22px] border-t border-[#1c1917]/7 bg-white px-5 py-24 text-center sm:py-[120px]">
					<h2 className="m-0 max-w-[720px] text-[clamp(2rem,4.5vw,2.625rem)] leading-[1.1] font-bold tracking-[-.03em] text-balance">
						Give your company a repository.
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
				<path d="M0 70 C 44 70, 36 160, 80 160" stroke="#E3DACC" strokeWidth="1.5" />
				<path d="M0 250 C 44 250, 36 160, 80 160" stroke="#E3DACC" strokeWidth="1.5" />
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
				<TreeFolder>ops</TreeFolder>
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
				<path d="M80 70 C 36 70, 44 160, 0 160" stroke="#E3DACC" strokeWidth="1.5" />
				<path d="M80 250 C 36 250, 44 160, 0 160" stroke="#E3DACC" strokeWidth="1.5" />
				<circle cx="0" cy="160" r="3" fill="#C2410C" />
			</svg>
			<div className="flex w-[300px] shrink-0 flex-col gap-7">
				<div className="overflow-hidden rounded-[14px] border border-[#f3d8be] bg-[#fbf5ea] shadow-[0_18px_44px_rgba(28,25,23,.1)]">
					<div className="flex items-center gap-2 px-3.5 py-2.5">
						<img
							className="size-3.5"
							src="/landing/claude-spark.svg"
							alt=""
						/>
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
				className={cn(
					"size-3",
					variant === "github" && "opacity-60 grayscale",
				)}
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
}: {
	label: string;
	title: string;
	body: string;
	visual: ReactNode;
	reverse?: boolean;
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
				<h3 className="m-0 text-[30px] leading-[1.18] font-bold tracking-[-.02em]">
					{title}
				</h3>
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
				icon="/landing/icon-sq-md.svg"
				name="launch-plan.md"
				highlighted
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
			<FileRow
				icon="/landing/icon-sq-mp4.svg"
				name="launch-video.mp4"
				meta="2.1 GB · v3 · no LFS needed"
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
						Approve
					</span>
					<span className="rounded-lg border border-[#ebdcc7] bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-[#44403c]">
						Decline
					</span>
				</span>
			</div>
			<div className="flex items-center gap-[9px] px-4 pt-0.5 pb-1 text-[12.5px] text-[#a8a29e]">
				<CheckIcon size={13} />
				<span>
					<b className="text-[#57534e]">Pricing one-pager v3</b> approved by
					Mara · 2 hr ago
				</span>
			</div>
		</div>
	);
}

function AgentsVisual() {
	return (
		<div
			className={cn(
				visualCard,
				"flex flex-col items-center justify-center gap-5 p-7 sm:flex-row sm:gap-0",
			)}
		>
			<div className="flex shrink-0 flex-col gap-3">
				<AgentPill
					icon="/landing/claude-spark.svg"
					name="Claude"
					person="Mara"
					highlighted
				/>
				<AgentPill
					icon="/landing/brand-openai.svg"
					name="ChatGPT"
					person="Jonas"
				/>
				<AgentPill
					icon="/landing/brand-gemini.svg"
					name="Gemini"
					person="Priya"
				/>
				<AgentPill icon="/landing/codex-icon.svg" name="Codex" person="CLI" />
			</div>
			<svg
				className="hidden shrink-0 sm:block"
				width="96"
				height="212"
				viewBox="0 0 96 212"
				fill="none"
				aria-hidden="true"
			>
				<path d="M0 22 C 52 22, 44 106, 96 106" stroke="#E3DACC" strokeWidth="1.5" />
				<path d="M0 78 C 52 78, 44 106, 96 106" stroke="#E3DACC" strokeWidth="1.5" />
				<path d="M0 134 C 52 134, 44 106, 96 106" stroke="#E3DACC" strokeWidth="1.5" />
				<path d="M0 190 C 52 190, 44 106, 96 106" stroke="#E3DACC" strokeWidth="1.5" />
				<circle cx="96" cy="106" r="3" fill="#C2410C" />
			</svg>
			<div className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-[#f3d8be] bg-[#fbefe4] px-5 py-[18px]">
				<span className="inline-flex items-center gap-2">
					<img
						className="size-[18px]"
						src="/landing/icon-folder.svg"
						alt=""
					/>
					<span className="font-mono text-[13px] font-bold text-[#1c1917]">
						@acme/company
					</span>
				</span>
				<span className="text-xs text-[#9a6b4f]">one repo · one history</span>
				<span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-[#8a8178]">
					<span className="size-[7px] rounded-full bg-[#19a463]" />
					MCP
				</span>
			</div>
		</div>
	);
}

function AgentPill({
	icon,
	name,
	person,
	highlighted = false,
}: {
	icon: string;
	name: string;
	person: string;
	highlighted?: boolean;
}) {
	return (
		<span
			className={cn(
				"box-border inline-flex h-11 items-center gap-[9px] rounded-[11px] border px-4",
				highlighted
					? "border-[#f3d8be] bg-[#fbf5ea]"
					: "border-[#e5e5e5] bg-[#f7f7f8]",
			)}
		>
			<img className="size-4 object-contain" src={icon} alt="" />
			<span
				className={cn(
					"text-[13.5px] font-bold",
					highlighted ? "text-[#c2410c]" : "text-[#1c1917]",
				)}
			>
				{name}
			</span>
			<span
				className={cn(
					"text-[11.5px]",
					highlighted ? "text-[#c88a5f]" : "text-[#a8a29e]",
				)}
			>
				{person}
			</span>
		</span>
	);
}

function HistoryVisual() {
	return (
		<div className="flex flex-col">
			<div
				className={cn(
					visualCard,
					"flex flex-col gap-2.5 px-4 pt-4 pb-5 sm:mr-7",
				)}
			>
				<div className="flex items-center gap-[9px] px-1.5 py-1">
					<img className="size-[18px]" src="/landing/icon-sq-md.svg" alt="" />
					<span className="text-[13.5px] font-semibold text-[#1c1917]">
						gtm/icp.md
					</span>
					<span className="ml-auto inline-flex items-center gap-[5px] text-xs font-semibold text-[#8a8178]">
						<ClockIcon />
						History
					</span>
				</div>
				<div className="flex flex-col px-2 pt-2 pb-1">
					<TimelineEntry current date="Feb 12" title="Startups removed from ICP" />
					<TimelineEntry date="Nov 8" title="Startups added to ICP" />
					<TimelineEntry last date="Oct 3" title="ICP drafted" />
				</div>
			</div>
			<div className="relative z-[2] mt-4 w-full max-w-[360px] rounded-[14px] border border-[#f3d8be] bg-[#fbf5ea] shadow-[0_20px_50px_rgba(28,25,23,.18)] sm:-mt-[26px] sm:ml-auto sm:w-[360px]">
				<div className="flex items-center gap-2 px-3.5 py-2.5">
					<img className="size-3.5" src="/landing/claude-spark.svg" alt="" />
					<span className="text-[12.5px] font-bold text-[#c2410c]">Claude</span>
					<span className="ml-auto text-[11px] text-[#c88a5f]">Jonas</span>
				</div>
				<div className="flex flex-col gap-2.5 px-3.5 pb-3.5">
					<div className="max-w-[250px] self-end rounded-[14px_14px_4px_14px] bg-[#efe3cc] px-3 py-[7px] text-[12.5px] leading-[1.45] text-[#292524]">
						Why did we stop selling to startups?
					</div>
					<div className="flex gap-[9px]">
						<span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[#fdf1e7]">
							<img
								className="size-[11px]"
								src="/landing/claude-spark.svg"
								alt=""
							/>
						</span>
						<span className="flex flex-col gap-[7px]">
							<span className="text-[12.5px] leading-[1.55] text-[#292524]">
								We removed startups from the ICP in February. 14 pilots, none
								converted to paid.
							</span>
							<span className="inline-flex items-center gap-[7px] self-start rounded-lg border border-[#ebdcc3] bg-white px-2.5 py-1.5">
								<img
									className="size-[13px]"
									src="/landing/icon-sq-md.svg"
									alt=""
								/>
								<span className="font-mono text-[11px] text-[#57534e]">
									lixray.com/…/gtm/icp.md
								</span>
								<span className="text-[10.5px] whitespace-nowrap text-[#c88a5f]">
									history · Feb 12
								</span>
							</span>
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

function TimelineEntry({
	date,
	title,
	current = false,
	last = false,
}: {
	date: string;
	title: string;
	current?: boolean;
	last?: boolean;
}) {
	return (
		<div className="flex gap-3.5">
			<span className="flex w-2.5 shrink-0 flex-col items-center">
				<span
					className={cn(
						"mt-1 size-[9px] rounded-full",
						current ? "bg-[#c2410c]" : "bg-[#d9cfc0]",
					)}
				/>
				{last ? null : <span className="w-[1.5px] flex-1 bg-[#f0ede8]" />}
			</span>
			<span className={cn("flex flex-col gap-0.5", !last && "pb-[18px]")}>
				<span
					className={cn(
						"text-[10.5px] font-bold tracking-[.06em] uppercase",
						current ? "text-[#c2410c]" : "text-[#a8a29e]",
					)}
				>
					{date}
				</span>
				<span
					className={cn(
						"text-[13px]",
						current ? "font-bold text-[#1c1917]" : "text-[#57534e]",
					)}
				>
					{title}
				</span>
			</span>
		</div>
	);
}

function RepoArea({
	path,
	title,
	body,
}: {
	path: string;
	title: string;
	body: string;
}) {
	return (
		<div className="flex flex-col gap-2.5 rounded-2xl border border-[#1c1917]/8 bg-[#fbf6f0] p-6">
			<span className="font-mono text-[13px] font-semibold text-[#c2410c]">
				{path}
			</span>
			<h3 className="m-0 text-[17px] font-bold">{title}</h3>
			<p className="m-0 text-sm leading-[1.6] text-[#57534e]">{body}</p>
		</div>
	);
}

function ClockIcon() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#8C8580"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</svg>
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
