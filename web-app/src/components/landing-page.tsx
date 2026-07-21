import { ArrowRight, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SiteHeader, useWorkspaceCta } from "~/components/site-header";
import { cn } from "~/lib/utils";

const primaryButton =
	"inline-flex items-center justify-center rounded-xl bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-7 py-3.5 text-[17px] font-bold whitespace-nowrap text-white no-underline shadow-[0_10px_26px_rgba(232,89,12,.35),inset_0_1px_0_rgba(255,255,255,.28)] transition hover:brightness-105";
const secondaryButton =
	"inline-flex items-center justify-center rounded-xl border border-[#1c1917]/12 bg-white px-6 py-3.5 text-base font-semibold whitespace-nowrap text-[#1c1917] no-underline transition hover:border-[#1c1917]/25";
const visualCard =
	"rounded-2xl border border-[#1c1917]/8 bg-white shadow-[0_24px_60px_rgba(28,25,23,.08)]";

export function LandingPage() {
	const { authLoaded, user, workspaceState, workspaceTo } = useWorkspaceCta();
	const [autoOpenLoaded, setAutoOpenLoaded] = useState(false);
	const [autoOpenEnabled, setAutoOpenEnabled] = useState(false);
	const [openPromptDismissed, setOpenPromptDismissed] = useState(false);
	const heroWorkspaceLabel = user
		? "Open LixRay"
		: "Create workspace — it's free";

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
					className="flex flex-col items-center gap-6 px-5 pt-10 text-center sm:pt-[90px] sm:px-14"
					aria-labelledby="landing-title"
				>
					<h1
						className="m-0 max-w-[1060px] text-[clamp(2.5rem,6vw,3.875rem)] leading-[1.08] font-bold tracking-[-.035em] text-balance"
						id="landing-title"
					>
						The shared workspace for your team and AI agents
					</h1>
					<p className="m-0 max-w-[660px] text-[21px] leading-[1.55] text-[#57534e] text-pretty">
						An AI workspace your whole team and every agent share — file-based,
						version controlled, one source of truth.
					</p>
					<div className="mt-3 flex flex-wrap items-center justify-center gap-3">
						<a className={primaryButton} href={workspaceTo}>
							{heroWorkspaceLabel}
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

				<div className="flex justify-center px-5 pt-14 pb-16 sm:px-14 sm:pt-16 lg:pb-[130px]">
					<HeroMock />
				</div>

				<section
					className="border-t border-[#1c1917]/7 bg-white"
					aria-label="What LixRay is"
				>
					<div className="mx-auto grid max-w-[1040px] gap-12 px-5 py-20 sm:grid-cols-3 sm:px-14 sm:py-[100px]">
						<Property
							icons={
								<>
									<img
										className="size-[19px]"
										src="/landing/icon-folder.svg"
										alt=""
									/>
									<img
										className="size-[19px]"
										src="/landing/icon-sq-csv.svg"
										alt=""
									/>
									<img
										className="size-[19px]"
										src="/landing/icon-sq-md.svg"
										alt=""
									/>
								</>
							}
							title="File-based"
							body="Because agents operate on files. Plain Markdown, CSV, and images in a folder — exactly what they read and write best. No lock-in."
						/>
						<Property
							icons={
								<>
									<span className="size-[19px] rounded-[5px] bg-[#bbf7d0] shadow-[inset_0_0_0_1px_#86efac]" />
									<span className="size-[19px] rounded-[5px] bg-[#fecaca] shadow-[inset_0_0_0_1px_#fca5a5]" />
								</>
							}
							title="Version controlled"
							body="Because you need to verify the work. Every change lands in one history — reviewable as a diff, reversible to any point."
						/>
						<Property
							icons={
								<>
									<img
										className="size-5"
										src="/landing/claude-spark.svg"
										alt=""
									/>
									<img
										className="size-5 object-contain"
										src="/landing/brand-openai.svg"
										alt=""
									/>
									<img
										className="size-5 object-contain"
										src="/landing/brand-gemini.svg"
										alt=""
									/>
									<img
										className="size-[19px]"
										src="/landing/codex-icon.svg"
										alt=""
									/>
								</>
							}
							title="Connect any agent"
							body="Claude, ChatGPT, Gemini, Codex — one click each. Everyone keeps the agent they already use."
						/>
					</div>
				</section>

				<section
					className="border-t border-[#1c1917]/7"
					aria-labelledby="why-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-10 px-5 py-24 sm:px-14 sm:py-[120px]">
						<h2
							className="m-0 text-center text-[clamp(2rem,4.5vw,2.375rem)] leading-[1.12] font-bold tracking-[-.03em] text-balance"
							id="why-title"
						>
							Why it changes how you work with agents
						</h2>
						<div className="mt-10 flex flex-col gap-24 sm:gap-[120px]">
							<WhyRow
								label="Same source of truth"
								title="Agents collaborate on the same files"
								body="People and agents read and write one shared set of files — not copies pasted into chats or emailed around. What an agent reads is exactly what your team sees, always current. Every file has a URL you can share read-only or invite others to edit."
								visual={<SourceOfTruthVisual />}
							/>
							<WhyRow
								reverse
								label="You stay in control"
								title="Delegate without losing control"
								body="Agent edits arrive as diffs you accept or reject — prose, tables, and data alike. Full history means you can see who changed what and roll anything back. Letting agents write stops being a leap of faith."
								visual={<HistoryVisual />}
							/>
							<WhyRow
								label="Sharable & collaborative"
								title="One agent's work is the next one's context"
								body="Because they share the files, one agent picks up where another left off. Mara's Claude rewrites the pricing; Jonas's ChatGPT reads that and adds the competitor table beneath it. Real collaboration, not scattered chats."
								visual={<HandoffVisual />}
							/>
						</div>
					</div>
				</section>

				<section
					className="border-t border-[#1c1917]/7 bg-white"
					aria-labelledby="use-cases-title"
				>
					<div className="mx-auto flex max-w-[1040px] flex-col gap-14 px-5 py-24 sm:px-14 sm:py-[110px]">
						<h2
							className="m-0 text-center text-[clamp(2rem,4.5vw,2.375rem)] leading-[1.12] font-bold tracking-[-.03em]"
							id="use-cases-title"
						>
							Prime use cases
						</h2>
						<div className="grid gap-6 sm:grid-cols-3">
							<UseCase
								chip={
									<>
										<span className="min-w-0 truncate font-mono text-[12.5px] text-[#44403c]">
											skills/research/SKILL.md
										</span>
										<span className="ml-auto font-mono text-[11.5px] whitespace-nowrap">
											<span className="text-[#15803d]">+6</span>{" "}
											<span className="text-[#b91c1c]">−2</span>
										</span>
									</>
								}
								title="Agent skills & prompts"
								body="The SKILL.md files, prompts, and instructions your agents run on. Edit them like code: diff each revision, see what changed behavior, roll back a bad edit."
							/>
							<UseCase
								chip={
									<>
										<span className="min-w-0 truncate font-mono text-[12.5px] text-[#44403c]">
											kb/refunds.md
										</span>
										<span className="ml-auto text-[11.5px] font-semibold whitespace-nowrap text-[#8a8178]">
											41 edits · 6 authors
										</span>
									</>
								}
								title="Knowledge bases"
								body="The articles your team and agents rely on for answers. Agents keep them current; attribution and rollback keep them trustworthy."
							/>
							<UseCase
								chip={
									<>
										<span className="min-w-0 truncate font-mono text-[12.5px] text-[#44403c]">
											launch-plan.md
										</span>
										<span className="ml-auto inline-flex items-center gap-[5px] rounded-full bg-[#fbefe4] px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-[#c2410c]">
											<BranchIcon />
											agent/pricing
										</span>
									</>
								}
								title="Docs & plans"
								body="Give an agent task its own branch. Compare the proposal against main, merge when it's right, discard when it isn't."
							/>
						</div>
					</div>
				</section>

				<section className="flex flex-col items-center gap-[22px] border-t border-[#1c1917]/7 bg-white px-5 py-24 text-center sm:py-[120px]">
					<h2 className="m-0 max-w-[680px] text-[clamp(2rem,4.5vw,2.625rem)] leading-[1.1] font-bold tracking-[-.03em] text-balance">
						Give your team and their agents one place to work
					</h2>
					<a className={cn(primaryButton, "mt-1")} href={workspaceTo}>
						{heroWorkspaceLabel}
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

function HeroMock() {
	return (
		<div
			className="relative w-full max-w-[1180px]"
			aria-label="Preview of a LixRay workspace with launch-plan.md open and two agents collaborating"
		>
			<div className="flex flex-col overflow-hidden rounded-2xl border border-[#1c1917]/10 bg-[#f4f2ef] shadow-[0_30px_80px_rgba(28,25,23,.12)] lg:h-[620px]">
				<div className="flex h-[38px] shrink-0 gap-2 px-2 pt-1.5">
					<div className="flex flex-1 items-center gap-1">
						<span className="inline-flex size-7 items-center justify-center rounded-[7px]">
							<HomeIcon />
						</span>
						<span className="inline-flex h-7 items-center gap-[7px] rounded-[7px] border border-[#ece8e2] bg-white px-3 text-[12.5px] font-semibold text-[#1c1917]">
							<img className="size-3.5" src="/landing/icon-sq-md.svg" alt="" />
							launch-plan.md
						</span>
					</div>
					<div className="hidden w-[280px] shrink-0 items-center md:flex">
						<span className="inline-flex h-7 items-center gap-[7px] rounded-[7px] border border-[#ece8e2] bg-white px-3 text-[12.5px] font-semibold text-[#1c1917]">
							<ClockIcon />
							History
						</span>
					</div>
				</div>
				<div className="flex flex-1 gap-2 overflow-hidden px-2 pb-2">
					<div className="flex min-w-0 flex-1 justify-center overflow-hidden rounded-[10px] border border-[#ece8e2] bg-white">
						<div className="w-full max-w-[560px] px-6 pt-9 pb-8 leading-[1.7] sm:pt-12 lg:pb-0">
							<h3 className="m-0 mb-4 text-[24px] leading-[1.25] font-bold tracking-[-.02em] text-[#1c1917] sm:text-[28px]">
								Launch plan
							</h3>
							<h4 className="m-0 mb-2 text-[17px] font-bold tracking-[-.01em] text-[#1c1917] sm:text-[19px]">
								Pricing
							</h4>
							<p className="m-0 mb-3 text-[14px] text-[#292524] sm:text-[15px]">
								<del className="rounded-[4px] bg-[#fee2e2] px-1 py-px text-[#8a5050] line-through decoration-[#dc8181]">
									Launch at a flat $29 per seat.
								</del>{" "}
								<ins className="rounded-[4px] bg-[#dcfce7] px-1 py-px no-underline shadow-[inset_0_0_0_1px_#bbe7c9]">
									Launch usage-based: $19 base plus metered agent calls, capped
									at $49 per seat.
								</ins>{" "}
								Annual plans keep the 20% discount.
							</p>
							<h4 className="m-0 mb-2 text-[17px] font-bold tracking-[-.01em] text-[#1c1917] sm:text-[19px]">
								Rollout
							</h4>
							<p className="m-0 text-[14px] text-[#292524] sm:text-[15px]">
								Beta customers migrate first week. Announcement post and press
								kit ship the morning of.
							</p>
						</div>
					</div>
					<div className="hidden w-[280px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-[#ece8e2] bg-white md:flex">
						<div className="flex flex-1 flex-col gap-0.5 overflow-hidden px-3 pt-3.5">
							<HistoryEntry
								highlighted
								title="Pricing rewritten to usage-based"
								meta={
									<>
										just now ·{" "}
										<span className="font-semibold text-[#c2410c]">
											Mara&apos;s Claude
										</span>
									</>
								}
							/>
							<HistoryEntry
								title="Competitor table added"
								meta={
									<>
										20 min ago ·{" "}
										<span className="font-semibold text-[#1c1917]">
											Jonas&apos;s ChatGPT
										</span>
									</>
								}
							/>
							<HistoryEntry
								title="Launch date confirmed"
								meta="1 hr ago · Mara"
							/>
						</div>
					</div>
				</div>
			</div>

			<div className="mt-5 flex flex-col gap-4 sm:flex-row lg:m-0">
				<div className="flex w-full flex-col overflow-hidden rounded-[18px] border border-[#f3d8be] bg-[#fbf5ea] shadow-[0_24px_70px_rgba(28,25,23,.2)] sm:max-w-[360px] lg:absolute lg:-bottom-11 lg:-left-[34px] lg:w-[360px]">
					<div className="flex items-center gap-2 px-4 py-3">
						<img
							className="size-[15px]"
							src="/landing/claude-spark.svg"
							alt=""
						/>
						<span className="text-[13px] font-bold text-[#c2410c]">Claude</span>
						<span className="ml-auto text-[11.5px] text-[#c88a5f]">Mara</span>
					</div>
					<div className="flex flex-col gap-[11px] px-4 pt-1 pb-4">
						<div className="max-w-[260px] self-end rounded-[14px_14px_4px_14px] bg-[#efe3cc] px-3 py-2 text-[13px] leading-[1.5] text-[#292524]">
							Switch the launch plan pricing to usage-based
						</div>
						<div className="text-[13px] leading-[1.55] text-[#292524]">
							Done — I edited{" "}
							<span className="rounded-[5px] bg-[#f3ead8] px-[5px] py-px font-mono text-xs">
								launch-plan.md
							</span>{" "}
							and proposed the change for your review.
						</div>
						<div className="flex items-center gap-2 rounded-xl border border-[#ebdcc3] bg-white px-3.5 py-2.5 text-[13px] text-[#b5a88f]">
							Reply to Claude…
							<span className="ml-auto inline-flex size-[22px] items-center justify-center rounded-[7px] bg-[#c2410c]">
								<SendIcon />
							</span>
						</div>
					</div>
				</div>

				<div className="flex w-full flex-col overflow-hidden rounded-[18px] border border-[#1c1917]/35 bg-white shadow-[0_24px_70px_rgba(28,25,23,.2)] sm:ml-auto sm:max-w-[340px] lg:absolute lg:-right-[34px] lg:-bottom-11 lg:w-[340px]">
					<div className="flex items-center gap-2 bg-[#1c1917] px-4 py-3">
						<img
							className="size-[15px] object-contain brightness-0 invert"
							src="/landing/brand-openai.svg"
							alt=""
						/>
						<span className="text-[13px] font-bold text-white">ChatGPT</span>
						<span className="ml-auto text-[11.5px] text-[#a8a29e]">Jonas</span>
					</div>
					<div className="flex flex-col gap-[11px] px-4 pt-3.5 pb-4">
						<div className="max-w-[250px] self-end rounded-[18px] bg-[#f0f0f0] px-3.5 py-2 text-[13px] leading-[1.5] text-[#1f1f1f]">
							Add a competitor pricing table
						</div>
						<span className="inline-flex items-center gap-[7px] self-start rounded-full border border-[#e5e5e5] bg-[#f7f7f8] px-3 py-[5px] text-xs text-[#444444]">
							<CheckIcon />
							Edited launch-plan.md
						</span>
						<div className="text-[13px] leading-[1.55] text-[#1f1f1f]">
							Added the table below Pricing — take a look.
						</div>
						<div className="flex items-center gap-2 rounded-full border border-[#d9d9d9] px-3.5 py-[9px] text-[13px] text-[#9b9b9b]">
							Message ChatGPT
							<span className="ml-auto inline-flex size-[22px] items-center justify-center rounded-full bg-[#1c1917]">
								<SendIcon />
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function HistoryEntry({
	title,
	meta,
	highlighted = false,
	actions,
	className,
}: {
	title: string;
	meta: ReactNode;
	highlighted?: boolean;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-px rounded-lg px-[11px] py-[9px]",
				highlighted && "gap-2 bg-[#fbefe4]",
				className,
			)}
		>
			<span
				className={cn(
					"text-[12.5px] font-semibold text-[#44403c]",
					highlighted && "font-bold text-[#1c1917]",
				)}
			>
				{title}
			</span>
			<span
				className={cn(
					"text-[11.5px] text-[#a8a29e]",
					highlighted && "text-[#9a6b4f]",
				)}
			>
				{meta}
			</span>
			{actions}
		</div>
	);
}

function Property({
	icons,
	title,
	body,
}: {
	icons: ReactNode;
	title: string;
	body: string;
}) {
	return (
		<div className="flex flex-col gap-3">
			<span className="inline-flex h-[26px] items-center gap-1.5">{icons}</span>
			<h3 className="m-0 mt-1.5 text-[19px] font-bold tracking-[-.01em]">
				{title}
			</h3>
			<p className="m-0 text-[15px] leading-[1.6] text-[#57534e] text-pretty">
				{body}
			</p>
		</div>
	);
}

function WhyRow({
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

function SourceOfTruthVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-3.5 p-5")}>
			<div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[#1c1917]/6 bg-[#f7f3ed] px-4 py-3.5">
				<img className="size-5" src="/landing/icon-sq-md.svg" alt="" />
				<span className="flex min-w-0 flex-col gap-px">
					<span className="text-sm font-bold text-[#1c1917]">
						launch-plan.md
					</span>
					<span className="truncate font-mono text-[11.5px] text-[#8a8178]">
						lixray.com/@acme/launch-q3/…
					</span>
				</span>
				<span className="ml-auto inline-flex items-center gap-2">
					<span className="inline-flex">
						<Avatar className="bg-[#1c1917] text-[#fbf6f0]">M</Avatar>
						<Avatar className="-ml-[7px] bg-[#57534e] text-[#fbf6f0]">J</Avatar>
						<Avatar className="-ml-[7px] bg-[#fdf1e7]">
							<img
								className="size-3"
								src="/landing/claude-spark.svg"
								alt="Claude"
							/>
						</Avatar>
						<Avatar className="-ml-[7px] bg-[#f1f0ee]">
							<img
								className="size-3 object-contain"
								src="/landing/brand-openai.svg"
								alt="ChatGPT"
							/>
						</Avatar>
					</span>
					<span className="text-xs font-semibold whitespace-nowrap text-[#15803d]">
						4 here
					</span>
				</span>
			</div>
			<div className="flex flex-col gap-2 px-0.5">
				<CrossedOut label="launch-plan_FINAL_v2.docx" note="emailed around" />
				<CrossedOut
					label="pasted into the chat"
					note="out of date on arrival"
				/>
			</div>
		</div>
	);
}

function HistoryVisual() {
	return (
		<div className={cn(visualCard, "overflow-hidden")}>
			<div className="flex items-center gap-[9px] border-b border-[#f3eee7] px-5 py-3.5">
				<img className="size-[19px]" src="/landing/icon-sq-md.svg" alt="" />
				<span className="text-[13.5px] font-semibold">launch-plan.md</span>
				<span className="ml-auto inline-flex items-center gap-[5px] text-xs font-semibold text-[#8a8178]">
					<ClockIcon />
					History
				</span>
			</div>
			<div className="flex flex-col gap-0.5 px-2.5 py-3">
				<HistoryEntry
					highlighted
					className="shadow-[inset_0_0_0_1px_#f3d8be]"
					title="Pricing rewritten to usage-based"
					meta={
						<>
							just now ·{" "}
							<span className="font-semibold text-[#c2410c]">
								Mara&apos;s Claude
							</span>{" "}
							·{" "}
							<span className="font-mono">
								<span className="text-[#15803d]">+12</span>{" "}
								<span className="text-[#b91c1c]">−4</span>
							</span>
						</>
					}
					actions={
						<span className="flex gap-1.5">
							<span className="rounded-md border border-[#ebdcc7] bg-white px-2.5 py-1 text-[11.5px] font-semibold text-[#44403c]">
								View diff
							</span>
							<span className="rounded-md border border-[#ebdcc7] bg-white px-2.5 py-1 text-[11.5px] font-semibold text-[#44403c]">
								Restore
							</span>
						</span>
					}
				/>
				<HistoryEntry
					title="Competitor table added"
					meta={
						<>
							20 min ago ·{" "}
							<span className="font-semibold text-[#1c1917]">
								Jonas&apos;s ChatGPT
							</span>{" "}
							· <span className="font-mono text-[#15803d]">+8</span>
						</>
					}
				/>
				<HistoryEntry title="Launch date confirmed" meta="1 hr ago · Mara" />
			</div>
		</div>
	);
}

function HandoffVisual() {
	return (
		<div className={cn(visualCard, "flex flex-col gap-3 p-5")}>
			<div className="flex items-start gap-3">
				<span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-[#fdf1e7]">
					<img className="size-4" src="/landing/claude-spark.svg" alt="" />
				</span>
				<span className="flex flex-col gap-0.5">
					<span className="text-[13.5px] leading-[1.5] text-[#292524]">
						<span className="font-bold text-[#c2410c]">Claude</span> rewrote{" "}
						<span className="rounded-[5px] bg-[#f3ead8] px-[5px] py-px font-mono text-xs">
							Pricing
						</span>{" "}
						to usage-based.
					</span>
					<span className="text-[11.5px] text-[#a8a29e]">2:14 PM · Mara</span>
				</span>
			</div>
			<div className="flex items-center gap-2 pl-[42px] text-xs text-[#c9c2b8]">
				<DownArrowIcon />
				reads the updated file
			</div>
			<div className="flex items-start gap-3">
				<span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-[#1c1917]">
					<img
						className="size-4 object-contain brightness-0 invert"
						src="/landing/brand-openai.svg"
						alt=""
					/>
				</span>
				<span className="flex flex-col gap-0.5">
					<span className="text-[13.5px] leading-[1.5] text-[#292524]">
						<span className="font-bold text-[#1c1917]">ChatGPT</span> added a
						competitor table under the new pricing.
					</span>
					<span className="text-[11.5px] text-[#a8a29e]">2:31 PM · Jonas</span>
				</span>
			</div>
		</div>
	);
}

function UseCase({
	chip,
	title,
	body,
}: {
	chip: ReactNode;
	title: string;
	body: string;
}) {
	return (
		<div className="flex flex-col gap-3.5 rounded-2xl border border-[#1c1917]/8 bg-white p-6 shadow-[0_18px_44px_rgba(28,25,23,.06)]">
			<div className="flex items-center gap-[9px] rounded-[10px] bg-[#f7f3ed] px-3.5 py-3">
				<img
					className="size-[18px] shrink-0"
					src="/landing/icon-sq-md.svg"
					alt=""
				/>
				{chip}
			</div>
			<h3 className="m-0 mt-1.5 text-lg font-bold tracking-[-.01em]">
				{title}
			</h3>
			<p className="m-0 text-[14.5px] leading-[1.6] text-[#57534e] text-pretty">
				{body}
			</p>
		</div>
	);
}

function Avatar({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex size-6 items-center justify-center rounded-full border-2 border-white text-[10.5px] font-semibold",
				className,
			)}
		>
			{children}
		</span>
	);
}

function CrossedOut({ label, note }: { label: string; note: string }) {
	return (
		<span className="flex items-center gap-[9px] text-[13px] text-[#b5afa6]">
			<XIcon />
			<span className="line-through">{label}</span>
			<span className="text-[11.5px] text-[#c9c2b8]">{note}</span>
		</span>
	);
}

function HomeIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#8C8580"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 10.5L12 3l9 7.5" />
			<path d="M5 9.5V21h14V9.5" />
		</svg>
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

function SendIcon() {
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#FFFFFF"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 19V5" />
			<path d="M5 12l7-7 7 7" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg
			width="11"
			height="11"
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

function XIcon() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#C9C2B8"
			strokeWidth="2.2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<line x1="5" y1="5" x2="19" y2="19" />
			<line x1="19" y1="5" x2="5" y2="19" />
		</svg>
	);
}

function DownArrowIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#C9C2B8"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 5v14" />
			<path d="M6 13l6 6 6-6" />
		</svg>
	);
}

function BranchIcon() {
	return (
		<svg
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="#C2410C"
			strokeWidth="2.4"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<path d="M6 3v12" />
			<circle cx="6" cy="18" r="2.5" />
			<circle cx="18" cy="6" r="2.5" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</svg>
	);
}
