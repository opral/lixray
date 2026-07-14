import { ArrowRight, ArrowUp, Check, Circle, Share2, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { workspacePath } from "~/lib/workspace-url";
import "./landing-page.css";

type FileEntry = {
	name: string;
	type: "markdown" | "csv" | "image" | "pdf";
	activity: string;
	avatar: string;
	agent?: keyof typeof agentMarks;
	hot?: boolean;
};

const agentMarks = {
	claude: "/landing/claude-official.png",
	chatgpt: "/landing/chatgpt-mark.svg",
	codex: "/landing/codex-mark.svg",
} as const;

const files: readonly FileEntry[] = [
	{
		name: "launch-plan.md",
		type: "markdown",
		activity: "Mara's Claude · editing",
		avatar: "/landing/avatar-mara.jpg",
		agent: "claude",
		hot: true,
	},
	{
		name: "announcement-post.md",
		type: "markdown",
		activity: "Jonas's ChatGPT · reading",
		avatar: "/landing/avatar-jonas.jpg",
		agent: "chatgpt",
	},
	{
		name: "q3-metrics.csv",
		type: "csv",
		activity: "Priya's Codex · 2 min ago",
		avatar: "/landing/avatar-priya.jpg",
		agent: "codex",
	},
	{
		name: "hero-shot.png",
		type: "image",
		activity: "Mara · Jun 28",
		avatar: "/landing/avatar-mara.jpg",
	},
	{
		name: "press-kit.pdf",
		type: "pdf",
		activity: "Jonas · Jun 27",
		avatar: "/landing/avatar-jonas.jpg",
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
		avatar: "/landing/avatar-mara.jpg",
	},
	{
		name: "AGENTS.md",
		type: "markdown",
		activity: "—",
		avatar: "/landing/avatar-mara.jpg",
	},
];

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
		<div className="landing-page">
			<header className="landing-header">
				<a className="landing-brand" href="/" aria-label="LixRay home">
					<img src="/lixray-mark.svg" alt="" />
					<span>LixRay</span>
				</a>
				<nav aria-label="Primary navigation">
					<a href="https://github.com/opral" target="_blank" rel="noreferrer">
						GitHub <span aria-hidden="true">↗</span>
					</a>
					{user ? (
						<button
							className="landing-nav-link"
							type="button"
							onClick={() => void signOut()}
						>
							Log out
						</button>
					) : null}
					<a className="landing-nav-cta" href={workspaceTo}>
						{workspaceLabel}
					</a>
				</nav>
				{user &&
				autoOpenLoaded &&
				workspaceState.isLoaded &&
				!autoOpenEnabled &&
				!openPromptDismissed ? (
					<div className="landing-open-prompt" role="status">
						<button
							className="landing-open-prompt-dismiss"
							type="button"
							aria-label="Dismiss"
							onClick={() => setOpenPromptDismissed(true)}
						>
							<X aria-hidden="true" />
						</button>
						<span>Skip this page next time?</span>
						<button type="button" onClick={alwaysOpenLixRay}>
							Always open LixRay <ArrowRight aria-hidden="true" />
						</button>
					</div>
				) : null}
			</header>

			<main>
				<section className="landing-hero" aria-labelledby="landing-title">
					<div className="landing-hero-copy">
						<h1 id="landing-title">
							The shared workspace
							<br />
							for your team and AI agents
						</h1>
						<div className="landing-hero-actions">
							<a className="landing-primary-button" href={workspaceTo}>
								{heroWorkspaceLabel} <ArrowRight aria-hidden="true" />
							</a>
							<a
								className="landing-secondary-button"
								href="https://cal.com/samuelstroschein/lixray-demo"
								target="_blank"
								rel="noreferrer"
							>
								Book a demo
							</a>
						</div>
						<div className="landing-proof">
							<span>Works with</span>
							<div
								className="landing-agent-logo-row"
								aria-label="Works with Claude, ChatGPT, Gemini, and Codex"
							>
								<img src="/landing/claude-official.png" alt="Claude" />
								<img src="/landing/chatgpt-mark.svg" alt="ChatGPT" />
								<img src="/landing/gemini-mark.svg" alt="Gemini" />
								<img src="/landing/codex-mark.svg" alt="Codex" />
							</div>
							<span>and more</span>
						</div>
					</div>
					<HeroVisual />
				</section>

				<section
					className="landing-story"
					id="why"
					aria-label="Problem and solution"
				>
					<div className="landing-story-block">
						<SectionHeading
							tone="problem"
							eyebrow="Problem"
							title="Your team's agents work in isolation"
						/>
						<ProblemVisual />
					</div>

					<div className="landing-story-block">
						<SectionHeading
							tone="solution"
							eyebrow="Solution"
							title="A collaborative workspace for your team's agents"
						/>
						<SolutionVisual />
					</div>
				</section>

				<section
					className="landing-features"
					id="features"
					aria-labelledby="features-title"
				>
					<div className="landing-features-intro">
						<h2 id="features-title">How it works</h2>
					</div>

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
				</section>

				<section className="landing-final-cta">
					<h2>Your shared workspace.</h2>
					<a className="landing-primary-button" href={workspaceTo}>
						{workspaceLabel} <ArrowRight aria-hidden="true" />
					</a>
				</section>
			</main>

			<footer className="landing-footer">
				<a className="landing-brand" href="/" aria-label="LixRay home">
					<img src="/lixray-mark.svg" alt="" />
					<span>LixRay</span>
				</a>
				<span>© 2026 Opral</span>
				<a href="https://github.com/opral" target="_blank" rel="noreferrer">
					GitHub
				</a>
			</footer>
		</div>
	);
}

function autoOpenStorageKey(userId: string) {
	return `lixray.landing.auto-open:${userId}`;
}

function SectionHeading({
	eyebrow,
	title,
	tone,
}: {
	eyebrow: string;
	title: string;
	tone: "problem" | "solution";
}) {
	return (
		<div className="landing-section-heading">
			<div className={`landing-eyebrow landing-eyebrow-${tone}`}>{eyebrow}</div>
			<h2>{title}</h2>
		</div>
	);
}

function BrowserDots() {
	return (
		<div className="landing-browser-dots" aria-hidden="true">
			<Circle className="landing-dot-red" />
			<Circle className="landing-dot-yellow" />
			<Circle className="landing-dot-green" />
		</div>
	);
}

function AgentMark({ agent }: { agent?: keyof typeof agentMarks }) {
	return agent ? (
		<img className="landing-agent-mark" src={agentMarks[agent]} alt="" />
	) : null;
}

function FileMark({ type }: { type: (typeof files)[number]["type"] }) {
	if (type === "markdown" || type === "csv") {
		return (
			<img
				className="landing-file-mark"
				src={
					type === "markdown"
						? "/landing/file-markdown.svg"
						: "/landing/file-csv.svg"
				}
				alt=""
			/>
		);
	}
	return (
		<span className={`landing-file-chip landing-file-chip-${type}`}>
			{type === "image" ? "PNG" : "PDF"}
		</span>
	);
}

function WorkspaceTable({ compact = false }: { compact?: boolean }) {
	const visibleFiles = compact ? heroFiles : files;

	return (
		<div
			className={`landing-workspace ${compact ? "landing-workspace-compact" : ""}`}
		>
			<div className="landing-window-bar">
				<BrowserDots />
				<div className="landing-window-title">
					<img src="/lixray-mark.svg" alt="" /> acme / launch-q3
				</div>
				<div className="landing-window-people" aria-hidden="true">
					<img src="/landing/avatar-mara.jpg" alt="" />
					<img src="/landing/avatar-jonas.jpg" alt="" />
					<img src="/landing/avatar-priya.jpg" alt="" />
				</div>
				<button type="button">Invite</button>
			</div>
			<div className="landing-file-head">
				<span>Name</span>
				<span>Activity</span>
				{compact ? <span>Changes</span> : null}
			</div>
			{visibleFiles.map((file) => (
				<div
					className={`landing-file-row ${file.hot ? "is-hot" : ""}`}
					key={file.name}
				>
					<div className="landing-file-name">
						<FileMark type={file.type} />
						<span>{file.name}</span>
					</div>
					<div className="landing-activity">
						<span className="landing-activity-identity">
							<img src={file.avatar} alt="" />
							<AgentMark agent={file.agent} />
						</span>
						<span>{file.activity}</span>
					</div>
					{compact ? (
						<span className="landing-file-changes">
							{file.type === "csv" ? (
								<>
									<b>+6</b> <i>−2</i>
								</>
							) : null}
						</span>
					) : null}
				</div>
			))}
		</div>
	);
}

function HeroVisual() {
	return (
		<div
			className="landing-visual-card landing-hero-visual"
			aria-label="A shared LixRay workspace used by multiple agents"
		>
			<WorkspaceTable compact />
			<div className="landing-chat-card landing-chat-claude">
				<div className="landing-chat-head">
					<div className="landing-chat-title">
						<img src="/landing/claude-official.png" alt="" /> Claude
					</div>
					<span>
						<img src="/landing/avatar-mara.jpg" alt="" /> Mara
					</span>
				</div>
				<div className="landing-chat-body">
					<p className="landing-chat-prompt">
						move the beta launch to October 19
					</p>
					<div className="landing-chat-status">
						<Circle aria-hidden="true" /> Editing{" "}
						<strong>launch-plan.md</strong>…
					</div>
					<div className="landing-chat-input">
						<img src="/lixray-mark.svg" alt="" />
						<span>Reply to Claude…</span>
						<ArrowUp aria-hidden="true" />
					</div>
				</div>
			</div>
			<div className="landing-chat-card landing-chat-gpt">
				<div className="landing-chat-head">
					<div className="landing-chat-title">
						<img src="/landing/chatgpt-mark-light.svg" alt="" /> ChatGPT
					</div>
					<span>
						<img src="/landing/avatar-jonas.jpg" alt="" /> Jonas
					</span>
				</div>
				<div className="landing-chat-body">
					<p className="landing-chat-prompt">when do we ship the beta?</p>
					<div className="landing-chat-read">
						<Check aria-hidden="true" /> Read <strong>launch-plan.md</strong>
					</div>
					<div className="landing-chat-answer">
						October 19 — Mara&apos;s Claude updated the plan a minute ago.
						Invites go to the waitlist first, public launch two weeks later.
					</div>
					<div className="landing-chat-file">
						<FileMark type="markdown" /> launch-plan.md
					</div>
					<div className="landing-chat-input">
						<img src="/lixray-mark.svg" alt="" />
						<span>Ask anything</span>
						<ArrowUp aria-hidden="true" />
					</div>
				</div>
			</div>
		</div>
	);
}

function ProblemVisual() {
	return (
		<div
			className="landing-visual-card landing-problem-visual"
			aria-label="Agents working in separate private contexts"
		>
			<div className="landing-isolated-card landing-isolated-claude">
				<div>
					<img src="/landing/claude-official.png" alt="" /> Mara&apos;s Claude
				</div>
				<strong>
					<FileMark type="markdown" /> launch-plan-v3-final.md
				</strong>
				<span>only Mara can see this</span>
			</div>
			<div className="landing-isolated-card landing-isolated-gpt">
				<div>
					<img src="/landing/chatgpt-mark-light.svg" alt="" /> Jonas&apos;s
					ChatGPT
				</div>
				<strong>
					<FileMark type="markdown" /> announcement (7).docx
				</strong>
				<span>downloaded to ~/Desktop</span>
			</div>
			<div className="landing-isolated-card landing-isolated-codex">
				<div>
					<img src="/landing/codex-mark.svg" alt="" /> Priya&apos;s Codex
				</div>
				<strong>$ ~/repos/metrics.csv</strong>
				<span>on Priya&apos;s laptop</span>
			</div>
		</div>
	);
}

function SolutionVisual() {
	return (
		<div
			className="landing-visual-card landing-solution-visual"
			aria-label="A collaborative workspace shared by the team"
		>
			<WorkspaceTable />
		</div>
	);
}

function FeatureRow({
	title,
	body,
	visual,
	reverse = false,
	badge,
}: {
	title: string;
	body: string;
	visual: ReactNode;
	reverse?: boolean;
	badge?: string;
}) {
	return (
		<article className={`landing-feature-row ${reverse ? "is-reverse" : ""}`}>
			<div className="landing-feature-copy">
				<h3>
					{title} {badge ? <span>{badge}</span> : null}
				</h3>
				<p>{body}</p>
			</div>
			<div className="landing-feature-visual">{visual}</div>
		</article>
	);
}

function ContextVisual() {
	return (
		<div className="landing-ui-window landing-context-window">
			<div className="landing-window-bar">
				<BrowserDots />
				<div className="landing-window-title">
					<FileMark type="markdown" /> launch-plan.md
				</div>
			</div>
			<div className="landing-context-body">
				<div className="landing-document">
					<h4>Launch plan</h4>
					<p>
						We ship the beta on October 19 with invites going to the waitlist
						first. Docs, pricing, and the announcement all reference the same
						launch date.
					</p>
					<p>
						The demo script pulls its numbers from{" "}
						<a href="#features">q3-metrics.csv</a>.
					</p>
				</div>
				<div className="landing-activity-panel">
					<strong>Activity</strong>
					<ActivityItem
						agent="claude"
						label="Claude edited the launch date"
						detail="editing now"
					/>
					<ActivityItem
						agent="chatgpt"
						label="ChatGPT read the plan"
						detail="10:15"
					/>
					<ActivityItem
						agent="codex"
						label="Codex read the metrics"
						detail="10:02"
					/>
				</div>
			</div>
		</div>
	);
}

function ActivityItem({
	agent,
	label,
	detail,
}: {
	agent: keyof typeof agentMarks;
	label: string;
	detail: string;
}) {
	return (
		<div className="landing-activity-item">
			<AgentMark agent={agent} />
			<div>
				<span>{label}</span>
				<small>{detail}</small>
			</div>
		</div>
	);
}

function ChangesVisual() {
	const rows = [
		["2026-05", "1,046", "$15,300", "2.2%"],
		["2026-06", "1,204", "$18,400", "2.1%"],
		["2026-07", "1,688", "$24,150", "1.8%"],
		["2026-08", "2,102", "$33,900", "1.6%"],
	];
	return (
		<div className="landing-ui-window landing-changes-window">
			<div className="landing-window-bar">
				<BrowserDots />
				<div className="landing-window-title">
					<FileMark type="csv" /> q3-metrics.csv
				</div>
			</div>
			<div className="landing-sheet">
				<div className="landing-sheet-row landing-sheet-head">
					<span>month</span>
					<span>signups</span>
					<span>revenue</span>
					<span>churn</span>
				</div>
				{rows.map((row, index) => (
					<div
						className={`landing-sheet-row ${index > 1 ? "is-edited" : ""}`}
						key={row[0]}
					>
						{row.map((cell, cellIndex) => (
							<span key={`${row[0]}-${cellIndex}`}>
								{index === 2 && cellIndex === 1 ? (
									<>
										<span className="landing-diff-old">1,590</span>
										<span className="landing-diff-new">1,688</span>
									</>
								) : index === 3 && cellIndex === 2 ? (
									<>
										<span className="landing-diff-old">$27,300</span>
										<span className="landing-diff-new">$33,900</span>
									</>
								) : (
									cell
								)}
							</span>
						))}
					</div>
				))}
			</div>
			<div className="landing-review-bar">
				<span>3 changes</span>
				<button type="button">
					<Check aria-hidden="true" /> Accept
				</button>
				<button type="button">Reject</button>
			</div>
		</div>
	);
}

function AgentsVisual() {
	const agents = [
		{
			name: "Claude",
			mark: "/landing/claude-official.png",
			state: "Connected",
			active: true,
			meta: "writing now",
		},
		{
			name: "ChatGPT",
			mark: "/landing/chatgpt-mark.svg",
			state: "Connected",
			active: true,
			meta: "10:15",
		},
		{
			name: "Gemini",
			mark: "/landing/gemini-mark.svg",
			state: "Connect",
			active: false,
			meta: "",
		},
		{
			name: "Codex",
			mark: "/landing/codex-mark.svg",
			state: "via folder",
			active: false,
			meta: "10:31",
		},
	] as const;
	return (
		<div className="landing-ui-window landing-agents-window">
			<div className="landing-window-bar">
				<BrowserDots />
				<button type="button">Connect agent</button>
			</div>
			<h4>Connected agents</h4>
			{agents.map((agent) => (
				<div className="landing-agent-row" key={agent.name}>
					<img src={agent.mark} alt="" />
					<strong>{agent.name}</strong>
					<span className={agent.active ? "is-connected" : ""}>
						{agent.active ? "✓ " : ""}
						{agent.state}
					</span>
					<small>{agent.meta}</small>
				</div>
			))}
		</div>
	);
}

function ShareVisual() {
	return (
		<div className="landing-ui-window landing-share-window">
			<div className="landing-window-bar">
				<BrowserDots />
				<div className="landing-window-title">
					<img src="/lixray-mark.svg" alt="" /> acme / launch-q3
				</div>
				<button type="button">
					<Share2 aria-hidden="true" /> Share
				</button>
			</div>
			<div className="landing-share-document">
				<h4>Launch plan</h4>
				<p>
					We ship the beta on October 19. Everyone on the team and their agents
					work from this plan.
				</p>
			</div>
			<div className="landing-share-dialog">
				<strong>Share launch-q3</strong>
				<p>Invite a teammate to the workspace and its full context.</p>
				<div>
					<input aria-label="Teammate email" defaultValue="jonas@acme.com" />
					<button type="button">Invite</button>
				</div>
			</div>
		</div>
	);
}
