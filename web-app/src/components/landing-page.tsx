import { ArrowRight, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { cn } from "~/lib/utils";
import { workspacePath } from "~/lib/workspace-url";

const primaryButton =
	"inline-flex items-center justify-center rounded-xl bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-7 py-3.5 text-[17px] font-bold whitespace-nowrap text-white no-underline shadow-[0_10px_26px_rgba(232,89,12,.35),inset_0_1px_0_rgba(255,255,255,.28)] transition hover:brightness-105";
const secondaryButton =
	"inline-flex items-center justify-center rounded-xl border border-[#1c1917]/12 bg-white px-6 py-3.5 text-base font-semibold whitespace-nowrap text-[#1c1917] no-underline transition hover:border-[#1c1917]/25";
const cardShell =
	"overflow-hidden rounded-2xl border border-[#1c1917]/8 bg-white shadow-[0_24px_60px_rgba(28,25,23,.08)]";
const monoChip =
	"rounded-[7px] bg-[#f7f3ed] px-2.5 py-1.5 font-mono text-[12.5px] text-[#44403c]";

export function LandingPage() {
	const { isLoaded: authLoaded, signOut, user } = useAuth();
	const workspaceState = useWorkspace();
	const [autoOpenLoaded, setAutoOpenLoaded] = useState(false);
	const [autoOpenEnabled, setAutoOpenEnabled] = useState(false);
	const [openPromptDismissed, setOpenPromptDismissed] = useState(false);
	const activeWorkspace = workspaceState.activeWorkspace;
	const workspaceTo = user
		? activeWorkspace
			? workspacePath(activeWorkspace.organization, activeWorkspace.workspace)
			: "/workspace"
		: "/sign-in";
	const workspaceLabel = user ? "Open LixRay" : "Get started";
	const heroWorkspaceLabel = user ? "Open LixRay" : "Get started — it's free";

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
			<header className="relative z-20 flex items-center justify-between px-5 py-6 sm:px-14">
				<Brand />
				<nav
					className="flex items-center gap-6 text-[15px] font-semibold"
					aria-label="Primary navigation"
				>
					{user ? (
						<button
							className="cursor-pointer border-0 bg-transparent p-0 text-[#1c1917] hover:text-[#e8590c]"
							type="button"
							onClick={() => void signOut()}
						>
							Log out
						</button>
					) : (
						<a className="text-[#1c1917] no-underline" href="/sign-in">
							Sign in
						</a>
					)}
					<a
						className="rounded-[10px] bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-[18px] py-2.5 font-bold text-white no-underline shadow-[0_6px_16px_rgba(232,89,12,.3),inset_0_1px_0_rgba(255,255,255,.25)] transition hover:brightness-105"
						href={workspaceTo}
					>
						{workspaceLabel}
					</a>
				</nav>
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
			</header>

			<main>
				<section
					className="flex flex-col items-center gap-6 px-5 pt-8 text-center sm:pt-12"
					aria-labelledby="landing-title"
				>
					<h1
						className="m-0 max-w-[820px] text-[clamp(2.5rem,6vw,4rem)] leading-[1.08] font-bold tracking-[-.035em] text-balance"
						id="landing-title"
					>
						One workspace for your team and AI agents
					</h1>
					<p className="m-0 max-w-[560px] text-[21px] leading-[1.55] text-[#57534e] text-pretty">
						Plain files in the browser that people and agents read and write
						together.
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
					<div className="mt-1.5 flex flex-wrap items-center justify-center gap-2.5 text-sm text-[#8a8178]">
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

				<div className="flex justify-center px-5 pt-12 pb-16 sm:pt-14 sm:pb-20">
					<HeroPreview />
				</div>

				<section
					className="border-t border-[#1c1917]/7 bg-white"
					aria-label="How it works"
				>
					<div className="mx-auto grid max-w-[1040px] gap-12 px-5 py-20 sm:grid-cols-3 sm:gap-14 sm:px-14 sm:py-[110px]">
						<Step
							number="01"
							title="Create a workspace"
							body="Your team's files live at one URL. Markdown, CSV, anything — open and edit them in the browser."
						>
							<span className="mt-1 self-start rounded-[7px] bg-[#f7f3ed] px-2.5 py-1.5 font-mono text-[12.5px] text-[#8a8178]">
								lixray.com/@acme/launch-q3
							</span>
						</Step>
						<Step
							number="02"
							title="Connect your agents"
							body="Claude, ChatGPT, and Gemini connect in one click. Everyone keeps the agent they already use."
						>
							<span className="mt-1 inline-flex items-center gap-2">
								<img
									className="size-4"
									src="/landing/claude-spark.svg"
									alt=""
								/>
								<img
									className="size-4 object-contain"
									src="/landing/brand-openai.svg"
									alt=""
								/>
								<img
									className="size-4 object-contain"
									src="/landing/brand-gemini.svg"
									alt=""
								/>
								<img
									className="size-[15px]"
									src="/landing/codex-icon.svg"
									alt=""
								/>
							</span>
						</Step>
						<Step
							number="03"
							title="Work in the same files"
							body="People and agents read and write the same context. Work carries cleanly from one to the next."
						/>
					</div>
				</section>

				<section className="border-t border-[#1c1917]/7" aria-label="Features">
					<div className="mx-auto flex max-w-[1040px] flex-col gap-24 px-5 py-24 sm:gap-[130px] sm:px-14 sm:py-[130px]">
						<FeatureRow
							title="Agents read and write like teammates"
							body="LixRay is an MCP server. Agents list, read, edit, and query workspace files with the same permissions you grant a person — nothing pasted, nothing stale."
							visual={<McpVisual />}
						/>
						<FeatureRow
							reverse
							title="Every change is a diff you review"
							body="Agent or teammate, prose or data — each edit lands as a tracked change with full history behind it. Nothing merges without a human signing off."
							visual={<DiffVisual />}
						/>
						<FeatureRow
							title="Share with a link"
							body="Every file has a URL. Send a read-only link to anyone, or an editable invite that brings teammates — and their agents — into the workspace."
							visual={<ShareVisual />}
						/>
					</div>
				</section>

				<section className="flex flex-col items-center gap-[22px] border-t border-[#1c1917]/7 px-5 py-24 text-center sm:py-[120px]">
					<h2 className="m-0 max-w-[620px] text-[clamp(2rem,4.5vw,2.625rem)] leading-[1.1] font-bold tracking-[-.03em] text-balance">
						Give your team and their agents one place to work
					</h2>
					<a className={cn(primaryButton, "mt-1")} href={workspaceTo}>
						{heroWorkspaceLabel}
					</a>
					<span className="text-sm text-[#8a8178]">
						Free while in beta · no credit card
					</span>
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

function Brand() {
	return (
		<a
			className="inline-flex items-center gap-[9px] text-lg font-bold tracking-[-.01em] text-[#1c1917] no-underline"
			href="/"
			aria-label="LixRay home"
		>
			<img className="size-[22px]" src="/lixray-mark.svg" alt="" />
			<span>LixRay</span>
		</a>
	);
}

const previewFiles = [
	{ name: "launch-plan.md", icon: "icon-sq-md", active: true },
	{ name: "announcement-post.md", icon: "icon-sq-md" },
	{ name: "pricing-page.md", icon: "icon-sq-md" },
	{ name: "q3-metrics.csv", icon: "icon-sq-csv" },
	{ name: "hero-shot.png", icon: "icon-sq-png" },
	{ name: "press-kit.pdf", icon: "icon-sq-pdf" },
	{ name: "AGENTS.md", icon: "icon-sq-md" },
];

function HeroPreview() {
	return (
		<div
			className="w-full max-w-[920px] overflow-hidden rounded-[20px] border border-[#1c1917]/10 bg-[#f4f2ef] shadow-[0_30px_80px_rgba(28,25,23,.12)]"
			aria-label="Preview of a LixRay workspace with launch-plan.md open"
		>
			<div className="relative flex h-[46px] items-center gap-2 px-3">
				<img className="size-[18px]" src="/lixray-mark.svg" alt="" />
				<div className="pointer-events-none absolute inset-0 hidden items-center justify-center gap-2 text-[13px] sm:flex">
					<span className="font-medium text-[#8c8580]">acme</span>
					<span className="text-[#c9c2b8]">/</span>
					<span className="font-medium text-[#8c8580]">launch-q3</span>
					<span className="text-[#c9c2b8]">/</span>
					<span className="font-semibold text-[#1c1917]">launch-plan.md</span>
				</div>
				<span className="flex-1" />
				<span className="inline-flex h-7 items-center rounded-[7px] border border-[#ddd6cb] bg-white px-[13px] text-xs font-semibold text-[#44403c] shadow-[0_1px_2px_rgba(28,25,23,.05)]">
					Share
				</span>
			</div>
			<div className="flex gap-[7px] px-2 pb-2 sm:h-[260px]">
				<div className="hidden w-[212px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-[#ece8e2] bg-white p-2 sm:flex">
					{previewFiles.map((file) => (
						<span
							className={cn(
								"flex items-center gap-2 rounded-[7px] px-[9px] py-1.5 text-[13px] text-[#57534e]",
								file.active && "bg-[#fbefe4] font-semibold text-[#1c1917]",
							)}
							key={file.name}
						>
							<img
								className="size-4"
								src={`/landing/${file.icon}.svg`}
								alt=""
							/>
							{file.name}
						</span>
					))}
				</div>
				<div className="relative flex-1 overflow-hidden rounded-[10px] border border-[#ece8e2] bg-white">
					<div className="mx-auto max-w-[520px] px-6 pt-9 pb-8 leading-[1.7] sm:px-4 sm:pb-0">
						<h3 className="m-0 mb-3.5 text-[24px] leading-[1.25] font-bold tracking-[-.02em] text-[#1c1917]">
							Launch plan
						</h3>
						<p className="m-0 mb-3 text-[13.5px] text-[#292524]">
							We ship the beta on <strong>October 19</strong>. Invites go to the
							waitlist first, and the announcement post goes live the same
							morning.
						</p>
						<p className="m-0 text-[13.5px] text-[#292524]">
							The demo pulls its numbers from q3-metrics.csv.{" "}
							<span className="rounded-[3px] bg-[#fbe7cf] box-decoration-clone px-0.5">
								Pricing moves to $12 per seat at launch — pricing-page.md and
								the announcement are updated to match.
							</span>
							<span
								className="ml-0.5 inline-block h-[15px] w-0.5 translate-y-[3px] rounded-full bg-[#f97316]"
								aria-hidden="true"
							/>
						</p>
					</div>
					<span className="absolute top-3 right-3 inline-flex items-center gap-[7px] rounded-full border border-[#f2d9bc] bg-white py-1.5 pr-3 pl-2 text-xs font-semibold text-[#c2410c] shadow-[0_6px_18px_rgba(28,25,23,.07)]">
						<img className="size-3.5" src="/landing/claude-spark.svg" alt="" />
						<span
							className="size-1.5 rounded-full bg-[#f97316]"
							aria-hidden="true"
						/>
						Mara&apos;s Claude is editing
					</span>
				</div>
			</div>
		</div>
	);
}

function Step({
	number,
	title,
	body,
	children,
}: {
	number: string;
	title: string;
	body: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2.5">
			<span className="font-mono text-[13px] text-[#c2410c]">{number}</span>
			<h3 className="m-0 text-[19px] font-bold tracking-[-.01em]">{title}</h3>
			<p className="m-0 text-[15px] leading-[1.6] text-[#57534e] text-pretty">
				{body}
			</p>
			{children}
		</div>
	);
}

function FeatureRow({
	title,
	body,
	visual,
	reverse = false,
}: {
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
				<h2 className="m-0 text-[34px] leading-[1.15] font-bold tracking-[-.025em]">
					{title}
				</h2>
				<p className="m-0 text-[16.5px] leading-[1.6] text-[#57534e] text-pretty">
					{body}
				</p>
			</div>
			<div className={cn(reverse && "lg:order-1")}>{visual}</div>
		</article>
	);
}

function McpVisual() {
	const tools = [
		"read_file",
		"write_file",
		"edit_file",
		"find_files",
		"list_directory",
		"execute",
	];
	return (
		<div className={cardShell}>
			<div className="flex items-center gap-2 border-b border-[#f3eee7] px-5 py-3.5 text-[13px] text-[#8a8178]">
				<img className="size-[15px]" src="/lixray-mark.svg" alt="" />
				<span className="font-mono">lixray.com/mcp</span>
				<span className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-[#15803d]">
					<span
						className="size-1.5 rounded-full bg-[#22c55e]"
						aria-hidden="true"
					/>
					Connected
				</span>
			</div>
			<div className="flex flex-wrap gap-2 px-5 py-[18px]">
				{tools.map((tool) => (
					<span className={monoChip} key={tool}>
						{tool}
					</span>
				))}
			</div>
			<div className="px-5 pb-[18px] text-[13px] text-[#8a8178]">
				Scoped by OAuth — agents only see workspaces their person can access.
			</div>
		</div>
	);
}

function DiffVisual() {
	return (
		<div className={cardShell}>
			<div className="flex items-center gap-[9px] border-b border-[#f3eee7] px-5 py-3.5">
				<img className="size-[19px]" src="/landing/icon-sq-md.svg" alt="" />
				<span className="text-[13.5px] font-semibold">launch-plan.md</span>
				<span className="ml-auto font-mono text-[12.5px]">
					<span className="text-[#15803d]">+6</span>{" "}
					<span className="text-[#b91c1c]">−2</span>
				</span>
			</div>
			<div className="flex flex-col gap-2.5 px-5 py-[18px]">
				<span className="h-[9px] w-[78%] rounded-[5px] bg-[#f0ebe3]" />
				<span className="h-[9px] w-[84%] rounded-[5px] border border-[#bbe7c9] bg-[#dcfce7]" />
				<span className="h-[9px] w-[62%] rounded-[5px] border border-[#bbe7c9] bg-[#dcfce7]" />
				<span className="h-[9px] w-[70%] rounded-[5px] border border-[#f3c4c4] bg-[#fee2e2] opacity-70" />
				<span className="h-[9px] w-[74%] rounded-[5px] bg-[#f0ebe3]" />
			</div>
			<div className="flex items-center gap-2.5 border-t border-[#f3eee7] px-5 py-3.5">
				<span className="inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-[#8a8178]">
					<img className="size-3.5" src="/landing/claude-spark.svg" alt="" />
					Proposed by Mara&apos;s Claude
				</span>
				<span className="ml-auto rounded-lg bg-[#1c1917] px-3.5 py-[7px] text-[13px] font-bold text-white">
					Accept
				</span>
				<span className="rounded-lg border border-[#1c1917]/12 px-3.5 py-[7px] text-[13px] font-semibold text-[#57534e]">
					Reject
				</span>
			</div>
		</div>
	);
}

function ShareVisual() {
	return (
		<div className="flex justify-center">
			<div className="flex w-full max-w-[400px] flex-col gap-3.5 rounded-2xl border border-[#1c1917]/8 bg-white p-5 shadow-[0_24px_60px_rgba(28,25,23,.08)]">
				<div className="flex items-center gap-[9px]">
					<img className="size-[19px]" src="/landing/icon-sq-md.svg" alt="" />
					<span className="text-sm font-bold">Share launch-plan.md</span>
				</div>
				<div className="flex items-stretch gap-2">
					<span className="flex h-[38px] min-w-0 flex-1 items-center overflow-hidden rounded-[9px] border border-[#1c1917]/7 bg-[#f7f3ed] px-3 font-mono text-[11.5px] whitespace-nowrap text-[#57534e]">
						lixray.com/@acme/launch-q3/launch-plan.md
					</span>
					<span className="inline-flex items-center rounded-[9px] bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-4 text-[13px] font-bold text-white">
						Copy
					</span>
				</div>
				<div className="flex gap-1.5 rounded-[10px] bg-[#f7f3ed] p-1">
					<span className="flex-1 rounded-[7px] bg-white py-[7px] text-center text-[13px] font-semibold shadow-[0_2px_6px_rgba(28,25,23,.08)]">
						Can edit
					</span>
					<span className="flex-1 py-[7px] text-center text-[13px] font-semibold text-[#8a8178]">
						Read only
					</span>
				</div>
			</div>
		</div>
	);
}
