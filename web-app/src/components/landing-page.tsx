import { ArrowRight, ArrowUp, Check, Circle, Share2, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { cn } from "~/lib/utils";
import { workspacePath } from "~/lib/workspace-url";

type Person = "mara" | "jonas" | "priya";
type FileType = "markdown" | "csv" | "image" | "pdf";
type Agent = keyof typeof agentMarks;

type FileEntry = {
	name: string;
	type: FileType;
	activity: string;
	person: Person;
	agent?: Agent;
	hot?: boolean;
};

const agentMarks = {
	claude: "/landing/claude-official.png",
	chatgpt: "/landing/chatgpt-mark.svg",
	codex: "/landing/codex-mark.svg",
	gemini: "/landing/gemini-mark.svg",
} as const;

const files: readonly FileEntry[] = [
	{
		name: "launch-plan.md",
		type: "markdown",
		activity: "Mara's Claude · editing",
		person: "mara",
		agent: "claude",
		hot: true,
	},
	{
		name: "announcement-post.md",
		type: "markdown",
		activity: "Jonas's ChatGPT · reading",
		person: "jonas",
		agent: "chatgpt",
	},
	{
		name: "q3-metrics.csv",
		type: "csv",
		activity: "Priya's Codex · 2 min ago",
		person: "priya",
		agent: "codex",
	},
	{
		name: "hero-shot.png",
		type: "image",
		activity: "Mara · Jun 28",
		person: "mara",
	},
	{
		name: "press-kit.pdf",
		type: "pdf",
		activity: "Jonas · Jun 27",
		person: "jonas",
	},
];

const heroFiles: readonly FileEntry[] = [
	files[0],
	files[1],
	files[2],
	{
		name: "pricing-page.md",
		type: "markdown",
		activity: "Mara · yesterday",
		person: "mara",
	},
];

const primaryButton =
	"inline-flex items-center justify-center gap-2 rounded-xl bg-[#f35a0a] px-6 py-3.5 text-sm font-bold text-white no-underline shadow-[0_12px_28px_rgba(226,73,7,.28),0_0_24px_rgba(249,115,22,.2),inset_0_1px_0_rgba(255,255,255,.3)] transition hover:-translate-y-0.5 hover:bg-[#e95005]";
const visualShell =
	"relative overflow-hidden rounded-3xl border border-[#e9d8ca] bg-[#fbeee3] [background-image:radial-gradient(circle,rgba(249,115,22,.16)_1px,transparent_1.4px)] [background-size:15px_15px]";
const windowShell =
	"overflow-hidden rounded-2xl border border-black/8 bg-white shadow-[0_20px_50px_rgba(83,49,27,.13)]";

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
	const heroWorkspaceLabel = user ? "Open LixRay" : "Create workspace free";

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
			<header className="relative z-20 mx-auto flex h-[66px] w-full items-center justify-between bg-[#ffd9bc] px-5 pt-4 sm:px-10 xl:px-20">
				<Brand />
				<nav
					className="flex items-center gap-3 text-sm font-semibold sm:gap-5"
					aria-label="Primary navigation"
				>
					<a
						className="hidden text-[#514a45] no-underline hover:text-black sm:inline"
						href="https://github.com/opral"
						target="_blank"
						rel="noreferrer"
					>
						GitHub <span aria-hidden="true">↗</span>
					</a>
					{user ? (
						<button
							className="cursor-pointer border-0 bg-transparent p-0 text-[#514a45] hover:text-black"
							type="button"
							onClick={() => void signOut()}
						>
							Log out
						</button>
					) : null}
					<a
						className="rounded-lg bg-[#f35a0a] px-4 py-2.5 text-white no-underline shadow-[0_8px_20px_rgba(226,73,7,.25)] transition hover:-translate-y-px"
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
						className="absolute top-[78px] right-5 grid w-[min(330px,calc(100vw-40px))] gap-2.5 rounded-[18px] border border-black/8 bg-white py-5 pr-12 pl-6 text-base shadow-[0_18px_48px_rgba(74,40,19,.18)] sm:right-10"
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
							Always open LixRay <ArrowRight className="size-4" aria-hidden="true" />
						</button>
					</div>
				) : null}
			</header>

			<main>
				<section
					className="flex w-full flex-col items-center bg-[linear-gradient(180deg,#ffd9bc_0%,#ffe3cc_28%,#fff1e5_62%,#fbf6f0_100%)] px-4 pt-16 pb-24 sm:px-10 sm:pt-20 sm:pb-28"
					aria-labelledby="landing-title"
				>
					<div className="relative z-10 flex max-w-4xl flex-col items-center text-center">
						<h1
							className="m-0 text-[clamp(2.5rem,6vw,4.75rem)] leading-[.98] font-[780] tracking-[-.055em] text-balance"
							id="landing-title"
						>
							The shared workspace
							<br />
							for your team and AI agents
						</h1>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<a className={primaryButton} href={workspaceTo}>
								{heroWorkspaceLabel} <ArrowRight className="size-4" aria-hidden="true" />
							</a>
							<a
								className="inline-flex items-center justify-center rounded-xl border border-stone-300 bg-white/80 px-6 py-3.5 text-sm font-bold text-stone-900 no-underline transition hover:-translate-y-0.5 hover:bg-white"
								href="https://cal.com/samuelstroschein/lixray-demo"
								target="_blank"
								rel="noreferrer"
							>
								Book a demo
							</a>
						</div>
						<div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm text-stone-500">
							<span>Works with</span>
							<div
								className="flex items-center gap-2"
								aria-label="Works with Claude, ChatGPT, Gemini, and Codex"
							>
								<img className="size-5 object-contain" src="/landing/claude-official.png" alt="Claude" />
								<img className="size-5 object-contain" src="/landing/chatgpt-mark.svg" alt="ChatGPT" />
								<img className="size-5 object-contain" src="/landing/gemini-mark.svg" alt="Gemini" />
								<img className="size-5 object-contain" src="/landing/codex-mark.svg" alt="Codex" />
							</div>
							<span>and more</span>
						</div>
					</div>
					<HeroVisual />
				</section>

				<section
					className="mx-auto flex max-w-7xl flex-col gap-24 px-4 py-16 sm:px-10 sm:py-24"
					id="why"
					aria-label="Problem and solution"
				>
					<StoryBlock tone="problem" title="Your team's agents work in isolation">
						<ProblemVisual />
					</StoryBlock>
					<StoryBlock
						tone="solution"
						title="A collaborative workspace for your team's agents"
					>
						<SolutionVisual />
					</StoryBlock>
				</section>

				<section
					className="mx-auto max-w-7xl px-4 py-20 sm:px-10 sm:py-28"
					id="features"
					aria-labelledby="features-title"
				>
					<h2
						className="mb-16 text-center text-4xl font-[760] tracking-[-.04em] sm:text-5xl"
						id="features-title"
					>
						How it works
					</h2>
					<div className="flex flex-col gap-16 sm:gap-20">
						<FeatureRow
							title="Connect your agents"
							body="Claude, ChatGPT, and Gemini connect in one click. CLI agents such as Codex use the shared folder directly. Your team keeps the tools it already likes."
							visual={<AgentsVisual />}
						/>
						<FeatureRow
							reverse
							title="Let them edit"
							body="Ask an agent to create a plan, update a document, or work through data. Everyone reads and writes the same context, so work carries cleanly from one agent to the next."
							visual={<ContextVisual />}
						/>
						<FeatureRow
							title="Every change is tracked and reviewable"
							body="Agent or teammate, prose or data — each change lands as a diff you can accept or reject, with complete history behind it. Nothing merges without a human signing off."
							visual={<ChangesVisual />}
						/>
						<FeatureRow
							reverse
							title="Share with your team and customers."
							body="Invite teammates or customers straight from the workspace. They see the files, their context, and the activity behind them."
							visual={<ShareVisual />}
						/>
					</div>
				</section>

				<section className="mx-auto flex max-w-4xl flex-col items-center gap-7 px-5 py-28 text-center">
					<h2 className="m-0 text-4xl font-[760] tracking-[-.04em] sm:text-6xl">
						Your shared workspace.
					</h2>
					<a className={primaryButton} href={workspaceTo}>
						{workspaceLabel} <ArrowRight className="size-4" aria-hidden="true" />
					</a>
				</section>
			</main>

			<footer className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-5 border-t border-stone-200 px-5 py-8 text-sm text-stone-950 sm:px-10">
				<Brand />
				<span>© 2026 Opral</span>
				<a className="font-semibold text-black no-underline" href="https://github.com/opral" target="_blank" rel="noreferrer">
					GitHub
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
		<a className="inline-flex items-center gap-2 text-lg font-[780] tracking-[-.02em] text-black no-underline" href="/" aria-label="LixRay home">
			<img className="size-[22px]" src="/lixray-mark.svg" alt="" />
			<span>LixRay</span>
		</a>
	);
}

function StoryBlock({ children, title, tone }: { children: ReactNode; title: string; tone: "problem" | "solution" }) {
	return (
		<div>
			<div className="mx-auto mb-9 max-w-4xl text-center">
				<div className={cn("mb-3 text-xs font-extrabold tracking-[.16em] uppercase", tone === "problem" ? "text-[#d9480f]" : "text-[#15803d]")}>
					{tone}
				</div>
				<h2 className="m-0 text-[clamp(2rem,4vw,3.4rem)] leading-[1.05] font-[760] tracking-[-.045em] text-balance">
					{title}
				</h2>
			</div>
			{children}
		</div>
	);
}

function BrowserDots() {
	return (
		<div className="flex items-center gap-2" aria-hidden="true">
			<Circle className="size-3 fill-[#ff6259] text-[#ff6259]" />
			<Circle className="size-3 fill-[#ffbd2e] text-[#ffbd2e]" />
			<Circle className="size-3 fill-[#28c840] text-[#28c840]" />
		</div>
	);
}

function AgentMark({ agent, className }: { agent?: Agent; className?: string }) {
	return agent ? <img className={cn("size-4 object-contain", className)} src={agentMarks[agent]} alt="" /> : null;
}

function PersonAvatar({ person, className }: { person: Person; className?: string }) {
	return (
		<span
			className={cn(
				"inline-grid size-5 shrink-0 place-items-center rounded-full text-[8px] leading-none font-extrabold text-[#3f3129]",
				person === "mara" && "bg-[#bfe3ef]",
				person === "jonas" && "bg-[#d8e9b9]",
				person === "priya" && "bg-[#d9c7f2]",
				className,
			)}
			aria-hidden="true"
		>
			{person[0].toUpperCase()}
		</span>
	);
}

function FileMark({ type }: { type: FileType }) {
	if (type === "markdown" || type === "csv") {
		return <img className="size-5 shrink-0 object-contain" src={type === "markdown" ? "/landing/file-markdown.svg" : "/landing/file-csv.svg"} alt="" />;
	}
	return (
		<span className={cn("grid size-5 shrink-0 place-items-center rounded text-[6px] font-extrabold text-white", type === "image" ? "bg-violet-500" : "bg-red-600")}>
			{type === "image" ? "PNG" : "PDF"}
		</span>
	);
}

function WindowBar({ children }: { children?: ReactNode }) {
	return (
		<div className="flex h-12 items-center gap-4 border-b border-stone-200 px-4">
			<BrowserDots />
			{children}
		</div>
	);
}

function WorkspaceTable({ compact = false }: { compact?: boolean }) {
	const visibleFiles = compact ? heroFiles : files;
	return (
		<div className={cn(windowShell, "w-full")}>
			<WindowBar>
				<div className="flex items-center gap-2 text-sm font-bold">
					<img className="size-4" src="/lixray-mark.svg" alt="" /> acme / launch-q3
				</div>
				<div className="ml-auto flex" aria-hidden="true">
					<PersonAvatar className="size-6 border-2 border-white text-[9px]" person="mara" />
					<PersonAvatar className="-ml-2 size-6 border-2 border-white text-[9px]" person="jonas" />
					<PersonAvatar className="-ml-2 size-6 border-2 border-white text-[9px]" person="priya" />
				</div>
				<button className="rounded-lg border-0 bg-[#f35a0a] px-3 py-2 text-xs font-bold text-white" type="button">
					Invite
				</button>
			</WindowBar>
			<div className={cn("grid h-9 items-center border-b border-stone-100 px-5 text-[10px] font-bold tracking-wider text-stone-400 uppercase", compact ? "grid-cols-[minmax(170px,1fr)_minmax(170px,.72fr)_70px]" : "grid-cols-[minmax(180px,1fr)_minmax(190px,.8fr)]")}>
				<span>Name</span><span>Activity</span>{compact ? <span>Changes</span> : null}
			</div>
			{visibleFiles.map((file) => (
				<div className={cn("grid min-h-14 items-center border-b border-stone-100 px-5 text-sm last:border-0", compact ? "grid-cols-[minmax(170px,1fr)_minmax(170px,.72fr)_70px]" : "grid-cols-[minmax(180px,1fr)_minmax(190px,.8fr)]", file.hot && "bg-orange-50/40")} key={file.name}>
					<div className="flex items-center gap-3 font-semibold"><FileMark type={file.type} /><span>{file.name}</span></div>
					<div className={cn("flex items-center gap-2 text-xs text-stone-500", file.hot && "font-semibold text-[#d9480f]")}>
						<span className="flex items-center"><PersonAvatar person={file.person} /><AgentMark className="-ml-1 size-3.5 rounded-full border border-white bg-white" agent={file.agent} /></span>
						<span>{file.activity}</span>
					</div>
					{compact ? <span className="text-xs"><b className="text-green-700">{file.type === "csv" ? "+6" : ""}</b> <i className="not-italic text-red-600">{file.type === "csv" ? "−2" : ""}</i></span> : null}
				</div>
			))}
		</div>
	);
}

function HeroVisual() {
	return (
		<div className="relative mt-14 h-[460px] w-full max-w-6xl px-[8%] pt-8 max-md:h-[360px] max-md:px-3 max-md:pt-4" aria-label="A shared LixRay workspace used by multiple agents">
			<div className="max-md:origin-top max-md:scale-[.72]"><WorkspaceTable compact /></div>
			<div className="absolute bottom-[-12px] left-[-2%] w-[330px] rounded-2xl border border-[#dfd2b6] bg-[#f8f1e4] shadow-[0_24px_60px_rgba(72,38,17,.3)] max-md:hidden">
				<div className="flex h-11 items-center border-b border-[#e5dac4] px-4 text-xs font-bold"><img className="mr-2 size-4" src="/landing/claude-official.png" alt="" />Claude<span className="ml-auto flex items-center gap-1.5 text-stone-500"><PersonAvatar person="mara" />Mara</span></div>
				<div className="space-y-2.5 p-4 text-xs"><p className="ml-auto w-fit rounded-xl bg-[#ece4d3] px-3 py-2">move the beta launch to October 19</p><div className="rounded-lg border border-[#dfd2b6] bg-white/70 px-3 py-2"><span className="text-orange-500">●</span> Editing <strong>launch-plan.md</strong>…</div><div className="flex items-center gap-2 rounded-lg border border-[#dfd2b6] bg-white px-3 py-2 text-stone-400"><img className="size-4" src="/lixray-mark.svg" alt="" />Reply to Claude…<ArrowUp className="ml-auto size-4" /></div></div>
			</div>
			<div className="absolute right-[-2%] bottom-[-30px] w-[380px] rounded-2xl bg-[#212121] text-white shadow-[0_32px_80px_rgba(40,20,5,.42)] max-md:hidden">
				<div className="flex h-11 items-center px-4 text-xs font-bold"><img className="mr-2 size-4" src="/landing/chatgpt-mark-light.svg" alt="" />ChatGPT<span className="ml-auto flex items-center gap-1.5 text-stone-400"><PersonAvatar person="jonas" />Jonas</span></div>
				<div className="space-y-2.5 p-4 text-xs"><p className="ml-auto w-fit rounded-xl bg-[#303030] px-3 py-2">when do we ship the beta?</p><div className="rounded-lg border border-white/10 bg-[#2b2b2b] px-3 py-2"><Check className="mr-1 inline size-3 text-emerald-400" /> Read <strong>launch-plan.md</strong></div><p className="leading-relaxed">October 19 — Mara&apos;s Claude updated the plan a minute ago. Invites go to the waitlist first.</p><div className="flex items-center gap-2 rounded-xl bg-[#303030] px-3 py-2 text-stone-400"><img className="size-4" src="/lixray-mark.svg" alt="" />Ask anything<ArrowUp className="ml-auto size-4" /></div></div>
			</div>
		</div>
	);
}

function ProblemVisual() {
	return (
		<div className={cn(visualShell, "relative h-[360px] p-6 sm:h-[390px]")} aria-label="Agents working in separate private contexts">
			<IsolatedCard className="top-10 left-[6%] bg-[#f7f0e3] text-stone-900" agent="claude" title="Mara's Claude" file="launch-plan-v3-final.md" note="only Mara can see this" />
			<IsolatedCard className="top-8 right-[7%] bg-[#232323] text-white" agent="chatgpt" title="Jonas's ChatGPT" file="announcement (7).docx" note="downloaded to ~/Desktop" />
			<IsolatedCard className="bottom-8 left-1/2 -translate-x-1/2 bg-[#eaf2ff] text-[#173b7a]" agent="gemini" title="Priya's Gemini" file="metrics.csv" fileType="csv" note="only Priya can see this" />
		</div>
	);
}

function IsolatedCard({ agent, className, file, fileType = "markdown", note, title }: { agent: Agent; className: string; file: string; fileType?: FileType; note: string; title: string }) {
	return <div className={cn("absolute w-[min(290px,40%)] rounded-xl p-4 text-xs shadow-[0_22px_45px_rgba(66,35,17,.2)] max-sm:w-[72%]", className)}><div className="mb-3 flex items-center gap-2 font-bold"><AgentMark className={agent === "chatgpt" ? "brightness-0 invert" : undefined} agent={agent} />{title}</div><strong className="flex items-center gap-2 rounded-lg border border-current/10 bg-white/35 px-3 py-2 font-mono"><FileMark type={fileType} />{file}</strong><span className="mt-2 block opacity-50">{note}</span></div>;
}

function SolutionVisual() {
	return <div className={cn(visualShell, "px-[12%] pt-10 max-md:px-3")} aria-label="A collaborative workspace shared by the team"><WorkspaceTable /></div>;
}

function FeatureRow({ title, body, visual, reverse = false }: { title: string; body: string; visual: ReactNode; reverse?: boolean }) {
	return (
		<article className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
			<div className={cn("max-w-lg", reverse && "lg:order-2")}><h3 className="m-0 text-3xl leading-tight font-[750] tracking-[-.035em] sm:text-4xl">{title}</h3><p className="mt-5 text-base leading-7 text-stone-600 sm:text-lg">{body}</p></div>
			<div className={cn(visualShell, "min-h-[350px] p-7 sm:min-h-[400px] sm:p-10", reverse && "lg:order-1")}>{visual}</div>
		</article>
	);
}

function AgentsVisual() {
	const agents = [
		["Claude", "/landing/claude-official.png", "Connected", "writing now"],
		["ChatGPT", "/landing/chatgpt-mark.svg", "Connected", "10:15"],
		["Gemini", "/landing/gemini-mark.svg", "Connect", ""],
		["Codex", "/landing/codex-mark.svg", "via folder", "10:31"],
	] as const;
	return <div className={cn(windowShell, "mx-auto max-w-xl")}><WindowBar><button className="ml-auto rounded-lg border-0 bg-[#f35a0a] px-3 py-2 text-xs font-bold text-white" type="button">Connect agent</button></WindowBar><h4 className="m-0 border-b border-stone-100 px-5 py-4 text-lg">Connected agents</h4>{agents.map(([name, mark, state, meta]) => <div className="grid grid-cols-[28px_1fr_auto_75px] items-center gap-3 border-b border-stone-100 px-5 py-4 last:border-0" key={name}><img className="size-6 object-contain" src={mark} alt="" /><strong>{name}</strong><span className={cn("rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-600", state === "Connected" && "bg-green-50 text-green-700")}>{state === "Connected" ? "✓ " : ""}{state}</span><small className="text-right text-stone-400">{meta}</small></div>)}</div>;
}

function ContextVisual() {
	return <div className={cn(windowShell, "mx-auto max-w-xl")}><WindowBar><div className="flex items-center gap-2 text-sm font-bold"><FileMark type="markdown" />launch-plan.md</div></WindowBar><div className="grid min-h-[290px] grid-cols-[1fr_145px]"><div className="p-6"><h4 className="mt-0 text-2xl">Launch plan</h4><p className="text-sm leading-6 text-stone-600">We ship the beta on October 19 with invites going to the waitlist first. Docs, pricing, and the announcement reference the same launch date.</p><p className="text-sm leading-6 text-stone-600">The demo script pulls its numbers from <span className="font-semibold text-orange-600">q3-metrics.csv</span>.</p></div><div className="border-l border-stone-100 p-4"><strong className="text-[10px] tracking-wider text-stone-400 uppercase">Activity</strong><ActivityItem agent="claude" label="Edited launch date" detail="now" /><ActivityItem agent="chatgpt" label="Read the plan" detail="10:15" /><ActivityItem agent="codex" label="Read metrics" detail="10:02" /></div></div></div>;
}

function ActivityItem({ agent, label, detail }: { agent: Agent; label: string; detail: string }) {
	return <div className="mt-4 flex gap-2 text-xs"><AgentMark className="mt-0.5" agent={agent} /><div><span className="block font-semibold">{label}</span><small className="text-stone-400">{detail}</small></div></div>;
}

function ChangesVisual() {
	const rows = [["2026-05", "1,046", "$15,300", "2.2%"], ["2026-06", "1,204", "$18,400", "2.1%"], ["2026-07", "1,688", "$24,150", "1.8%"], ["2026-08", "2,102", "$33,900", "1.6%"]];
	return <div className={cn(windowShell, "mx-auto max-w-xl")}><WindowBar><div className="flex items-center gap-2 text-sm font-bold"><FileMark type="csv" />q3-metrics.csv</div></WindowBar><div>{rows.map((row, index) => <div className={cn("grid grid-cols-4 border-b border-stone-100 text-xs", index === 0 && "bg-stone-50 font-bold text-stone-500", index > 1 && "bg-red-50/40")} key={row[0]}>{row.map((cell, cellIndex) => <span className="border-r border-stone-100 px-3 py-3 last:border-0" key={`${row[0]}-${cellIndex}`}>{index === 2 && cellIndex === 1 ? <><s className="mr-1 rounded bg-red-100 px-1 text-red-700">1,590</s><b className="rounded bg-green-100 px-1 text-green-700">1,688</b></> : index === 3 && cellIndex === 2 ? <><s className="mr-1 rounded bg-red-100 px-1 text-red-700">$27,300</s><b className="rounded bg-green-100 px-1 text-green-700">$33,900</b></> : cell}</span>)}</div>)}</div><div className="flex items-center gap-2 p-3 text-xs"><span className="mr-auto font-semibold">3 changes</span><button className="inline-flex items-center gap-1 rounded-lg border-0 bg-green-700 px-3 py-2 font-bold text-white" type="button"><Check className="size-3" />Accept</button><button className="rounded-lg border border-stone-300 bg-white px-3 py-2 font-bold" type="button">Reject</button></div></div>;
}

function ShareVisual() {
	return <div className={cn(windowShell, "relative mx-auto min-h-[310px] max-w-xl")}><WindowBar><div className="flex items-center gap-2 text-sm font-bold"><img className="size-4" src="/lixray-mark.svg" alt="" />acme / launch-q3</div><button className="ml-auto inline-flex items-center gap-1 rounded-lg border-0 bg-[#f35a0a] px-3 py-2 text-xs font-bold text-white" type="button"><Share2 className="size-3" />Share</button></WindowBar><div className="p-6"><h4 className="mt-0 text-2xl">Launch plan</h4><p className="max-w-sm text-sm leading-6 text-stone-600">We ship the beta on October 19. Everyone on the team and their agents work from this plan.</p></div><div className="absolute right-5 bottom-5 left-5 rounded-xl border border-stone-200 bg-white p-4 shadow-xl"><strong>Share launch-q3</strong><p className="my-2 text-xs text-stone-500">Invite a teammate to the workspace and its full context.</p><div className="flex gap-2"><input className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" aria-label="Teammate email" defaultValue="jonas@acme.com" /><button className="rounded-lg border-0 bg-[#f35a0a] px-3 py-2 text-xs font-bold text-white" type="button">Invite</button></div></div></div>;
}
