import { Link } from "@tanstack/react-router";
import {
	CircleCheck,
	Folder,
	GitPullRequest,
	History,
	Smile,
	Table2,
	UsersRound,
} from "lucide-react";
import { SiteHeader, useRepositoryCta } from "~/components/site-header";
import { WhyRepositoryIllustration } from "~/components/why-repository-illustration";

const iconPath = (name: string) => "/landing/" + name + ".svg";

function FileIcon({
	name,
	className = "size-[15px]",
}: {
	name: string;
	className?: string;
}) {
	return <img className={className} src={iconPath(name)} alt="" />;
}

function TreeRow({
	name,
	icon,
	indent = false,
	selected = false,
	badge,
}: {
	name: string;
	icon: string;
	indent?: boolean;
	selected?: boolean;
	badge?: string;
}) {
	return (
		<div
			className={
				"flex min-h-[27px] min-w-0 items-center gap-2 rounded-md px-2.5 text-[14px] " +
				(indent ? "ml-4 " : "") +
				(selected ? "bg-bg-hover" : "")
			}
		>
			{icon === "icon-folder" ? (
				<Folder
					className="size-[15px] shrink-0 text-fg-subtle"
					strokeWidth={1.6}
					aria-hidden="true"
				/>
			) : icon === "icon-table" ? (
				<Table2
					className="size-[15px] shrink-0 text-fg-subtle"
					strokeWidth={1.6}
					aria-hidden="true"
				/>
			) : (
				<FileIcon name={icon} className="size-[15px] shrink-0 object-contain" />
			)}
			<span className="min-w-0 flex-1 truncate">{name}</span>
			{badge && (
				<span
					className="text-[12px] font-semibold text-fg-subtle"
					aria-label={badge === "M" ? "Modified" : "Added"}
				>
					{badge}
				</span>
			)}
		</div>
	);
}

function RepositoryPreview() {
	return (
		<figure
			className="m-0 overflow-hidden rounded-2xl border border-border bg-panel shadow-lg"
			aria-label="Repository preview showing Claude's proposed document and customer table changes ready for review"
		>
			<div className="grid grid-cols-1 sm:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-0.5 border-b border-border-subtle px-2.5 py-4 sm:min-h-[365px] sm:border-r sm:border-b-0">
					<TreeRow name="finance" icon="icon-folder" />
					<TreeRow name="books.xlsx" icon="icon-sq-xlsx" indent />
					<TreeRow name="docs" icon="icon-folder" />
					<TreeRow
						name="handbook.docx"
						icon="icon-sq-docx"
						indent
						selected
						badge="M"
					/>
					<TreeRow name="launch-deck.pdf" icon="icon-sq-pdf" indent />
					<TreeRow name="tables" icon="icon-folder" />
					<TreeRow name="orders" icon="icon-table" indent />
					<TreeRow
						name="customers"
						icon="icon-table"
						indent
						selected
						badge="+"
					/>
				</div>

				<div className="flex min-w-0 flex-col px-5 pt-5 pb-4">
					<div className="mb-4 flex items-center gap-2 text-[15px]">
						<FileIcon name="claude-spark" className="size-[17px]" />
						<strong>Claude</strong>
						<span className="text-fg-muted">proposes changes</span>
					</div>

					<div className="overflow-hidden rounded-[10px] border border-border">
						<div className="flex items-center gap-2 border-b border-border-subtle bg-bg-subtle px-3 py-2 text-[13px] font-semibold">
							<FileIcon name="icon-sq-docx" className="size-[14px]" />
							handbook.docx
						</div>
						<p className="m-0 px-3 py-3 text-[13px] leading-[1.5]">
							Refunds are accepted within{" "}
							<del className="bg-danger-subtle text-danger">14</del>{" "}
							<ins className="bg-success-subtle text-success no-underline">
								30
							</ins>{" "}
							days.
						</p>
					</div>

					<div className="mt-2.5 overflow-hidden rounded-[10px] border border-border">
						<div className="flex items-center gap-2 border-b border-border-subtle bg-bg-subtle px-3 py-2 text-[13px] font-semibold">
							<Table2
								className="size-[14px] text-fg-subtle"
								strokeWidth={1.7}
								aria-hidden="true"
							/>
							customers
						</div>
						<div className="px-3 py-2.5 text-[12.5px]">
							<p className="m-0 mb-1.5 text-fg-subtle">2 new customers</p>
							<div className="flex items-center gap-2 rounded bg-success-subtle px-2 py-1 text-success">
								<span aria-hidden="true">+</span>
								<span className="min-w-0 flex-1">Northwind</span>
								<span>Berlin</span>
							</div>
							<div className="mt-1 flex items-center gap-2 rounded bg-success-subtle px-2 py-1 text-success">
								<span aria-hidden="true">+</span>
								<span className="min-w-0 flex-1">Bluebird Café</span>
								<span>Lisbon</span>
							</div>
						</div>
					</div>

					<div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3.5 text-[13px]">
						<span className="mr-auto inline-flex items-center gap-1.5 font-semibold text-success">
							<CircleCheck
								className="size-4 fill-success text-panel"
								strokeWidth={2}
								aria-hidden="true"
							/>
							Checks passed
						</span>
						<span className="rounded-[7px] border border-border px-3 py-1.5 text-fg-muted">
							Discard
						</span>
						<span className="rounded-[7px] bg-fg px-3 py-1.5 font-semibold text-panel">
							Accept
						</span>
					</div>
				</div>
			</div>
		</figure>
	);
}

const featureCopy = [
	{
		title: "Simple to use",
		description:
			"Web-based, with real-time collaboration and automatic commits.",
		icon: <Smile className="size-[18px]" strokeWidth={2} aria-hidden="true" />,
	},
	{
		title: "Any file format",
		description: "Documents, spreadsheets, PDFs, and video.",
		icon: (
			<span className="flex items-center gap-1" aria-hidden="true">
				{["icon-sq-docx", "icon-sq-xlsx", "icon-sq-pdf", "icon-sq-mp4"].map(
					(name) => (
						<FileIcon key={name} name={name} className="size-[14px]" />
					),
				)}
			</span>
		),
	},
	{
		title: "Even supports tables",
		description: "For customer lists, orders, and more.",
		icon: (
			<Table2 className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
		),
	},
] as const;

const connectedApps = [
	{
		title: "Internal apps",
		description: "Dashboards, scripts, and apps that your team builds.",
	},
	{
		title: "External apps",
		description:
			"Products from other companies, for example a translation app or a CRM.",
	},
	{
		title: "AI agents",
		description: "Claude, ChatGPT, Gemini, or the next model.",
	},
] as const;

const inlangReuse = [
	{
		title: "Data",
		description:
			"Translations are files in the repository, next to the code that uses them.",
	},
	{
		title: "Automation",
		description: "The company’s CI/CD checks and translates on each commit.",
	},
	{
		title: "Review",
		description:
			"Translation changes go through the same pull requests as code changes.",
	},
] as const;

const codexSetup = `codex mcp add LixRay --url https://lixray.com/mcp --oauth-resource https://lixray.com
codex mcp login LixRay`;

const sdkExample = `import { openLix } from "@lix-js/sdk";

const lix = await openLix({
  server: {
    mode: "remote",
    url: \`https://lixray.com/lix/\${repositoryId}\`,
    headers: async () => ({
      Authorization: \`Bearer \${process.env.LIXRAY_API_TOKEN}\`,
    }),
  },
});

await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
  "/notes/status.txt",
  new TextEncoder().encode("ready"),
]);`;

function CodeBlock({ code, label }: { code: string; label: string }) {
	return (
		<pre
			className="m-0 max-w-full overflow-x-auto rounded-[10px] border border-border bg-panel px-4 py-3.5 text-[13px] leading-[1.6]"
			aria-label={label}
		>
			<code className="font-mono">{code}</code>
		</pre>
	);
}

const sectionTitle =
	"m-0 text-[30px] leading-[1.2] font-bold tracking-[-.02em] text-balance";
const sectionText = "m-0 text-[18px] leading-[1.65] text-fg-muted";

const reviewBenefits = [
	{
		title: "Change proposals",
		description: "Anyone can propose a change.",
		icon: GitPullRequest,
	},
	{
		title: "Checks",
		description: "Tests run before merge.",
		icon: CircleCheck,
	},
	{
		title: "Contributors",
		description: "Services and partners write back.",
		icon: UsersRound,
	},
	{
		title: "History",
		description: "AI agents can learn from history.",
		icon: History,
	},
] as const;

export function LandingPage() {
	const { user, repositoryTo } = useRepositoryCta();

	return (
		<div
			className="min-h-screen bg-bg text-fg antialiased"
			style={{
				fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
			}}
		>
			<SiteHeader />
			<main>
				<section
					className="mx-auto w-full max-w-[800px] px-8 pt-12 pb-12 sm:pt-14"
					aria-labelledby="landing-title"
				>
					<h1
						id="landing-title"
						className="m-0 text-[clamp(38px,10vw,52px)] leading-[1.08] font-bold tracking-[-.04em] text-balance"
					>
						A shared repository for your company’s data and AI agents.
					</h1>
					<p className="mt-7 mb-0 text-[19px] leading-[1.6] text-fg-muted text-pretty">
						Files and SQL tables with version control. Every agent edit is a
						change you can review, merge, or roll back.
					</p>
					<div className="mt-7 flex flex-wrap items-center gap-2.5 text-[15px] text-fg-subtle">
						<span>Works with</span>
						<span
							className="inline-flex items-center gap-[9px]"
							aria-label="Claude, ChatGPT, and Gemini"
						>
							<img
								className="size-[17px]"
								src={iconPath("claude-spark")}
								alt="Claude"
							/>
							<img
								className="size-[17px]"
								src={iconPath("brand-openai")}
								alt="ChatGPT"
							/>
							<img
								className="size-[17px]"
								src={iconPath("brand-gemini")}
								alt="Gemini"
							/>
						</span>
						<span>and any MCP agent</span>
					</div>
					<div className="mt-[22px]">
						<a
							className="inline-flex min-h-[48px] items-center justify-center rounded-[10px] bg-[image:var(--atelier-accent-gradient)] px-6 text-[17px] font-bold text-accent-on no-underline shadow-accent transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							href={repositoryTo}
						>
							{user ? "Open LixRay" : "Create your repo for free"}
						</a>
					</div>
				</section>

				<section
					className="mx-auto w-full max-w-[800px] px-8"
					aria-label="Repository preview"
				>
					<RepositoryPreview />
				</section>

				<section
					className="mx-auto w-full max-w-[800px] px-8 pt-14"
					aria-label="LixRay features"
				>
					<div className="grid grid-cols-1 gap-7 min-[520px]:grid-cols-3">
						{featureCopy.map(({ title, description, icon }) => (
							<div key={title} className="flex flex-col gap-2.5">
								<div className="flex min-h-[20px] items-center">{icon}</div>
								<strong className="text-[17px] leading-tight">{title}</strong>
								<p className="m-0 text-[15px] leading-[1.55] text-fg-muted">
									{description}
								</p>
							</div>
						))}
					</div>
				</section>

				<section
					className="mx-auto flex w-full max-w-[800px] flex-col gap-8 px-8 pt-[120px] pb-24"
					aria-labelledby="why-title"
				>
					<h2
						id="why-title"
						className="m-0 text-[30px] leading-[1.2] font-bold tracking-[-.02em] text-balance"
					>
						Why a company repository?
					</h2>
					<p className="m-0 text-[18px] leading-[1.65] text-fg-muted">
						A company repository holds all company data: files, tables, and
						history. Apps and agents connect to the repository. They do not keep
						their own copy.
					</p>
					<ul className="m-0 flex list-none flex-col gap-3 p-0 text-[17px] leading-[1.55] text-fg-muted">
						{connectedApps.map(({ title, description }) => (
							<li key={title}>
								<strong className="text-fg">{title}.</strong> {description}
							</li>
						))}
					</ul>
					<p className={sectionText}>
						We learned this at{" "}
						<a
							className="font-semibold text-fg underline-offset-2"
							href="https://inlang.com"
							target="_blank"
							rel="noreferrer"
						>
							inlang
						</a>
						, where Lix started. Inlang stores translations in the company’s git
						repository, next to the source code. Inlang did not build its own
						storage, automation, or review. It uses what the company already
						has:
					</p>
					<ul className="m-0 flex list-none flex-col gap-3 p-0 text-[17px] leading-[1.55] text-fg-muted">
						{inlangReuse.map(({ title, description }) => (
							<li key={title}>
								<strong className="text-fg">{title}.</strong> {description}
							</li>
						))}
					</ul>
					<WhyRepositoryIllustration />
					<div className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-4">
						{reviewBenefits.map(({ title, description, icon: Icon }) => (
							<div key={title} className="flex min-w-0 flex-col gap-1.5">
								<h3 className="m-0 flex items-center gap-2 text-[15.5px] leading-tight font-bold">
									<Icon
										className="size-[17px] shrink-0"
										strokeWidth={1.8}
										aria-hidden="true"
									/>
									{title}
								</h3>
								<p className="m-0 text-[14.5px] leading-[1.55] text-fg-muted">
									{description}
								</p>
							</div>
						))}
					</div>
				</section>

				<section
					className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-8 pb-24"
					aria-labelledby="connect-title"
				>
					<h2 id="connect-title" className={sectionTitle}>
						Connect an agent
					</h2>
					<p className={sectionText}>
						The MCP endpoint is{" "}
						<code className="font-mono text-[16px] text-fg">
							https://lixray.com/mcp
						</code>
						. It uses OAuth. In Codex:
					</p>
					<CodeBlock code={codexSetup} label="Codex setup commands" />
					<p className={sectionText}>
						In other clients, add the endpoint as a remote MCP server.
					</p>
				</section>

				<section
					className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-8 pb-24"
					aria-labelledby="sdk-title"
				>
					<h2 id="sdk-title" className={sectionTitle}>
						Use the SDK
					</h2>
					<p className={sectionText}>
						Install{" "}
						<code className="font-mono text-[16px] text-fg">@lix-js/sdk</code>,
						create an API token in a repository under Settings → API tokens, and
						connect:
					</p>
					<CodeBlock code={sdkExample} label="SDK example" />
				</section>

				<section
					className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-8 pb-[140px]"
					aria-labelledby="comparison-title"
				>
					<h2 id="comparison-title" className={sectionTitle}>
						How it compares
					</h2>
					<p className={sectionText}>
						In the future, LixRay will mount external data, with Google Drive,
						Notion, and GitHub as sources.
					</p>
					<p className={sectionText}>
						<strong className="text-fg">GitHub</strong> has version control, but
						can’t store tables and is hard to use.
					</p>
					<p className={sectionText}>
						<strong className="text-fg">Notion</strong> has tables, but no real
						files. Uploads are attachments you can’t edit in place.
					</p>
					<p className={sectionText}>
						<strong className="text-fg">Google Drive</strong> has files, but no
						tables and no version control across them.
					</p>
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
				<nav className="flex flex-wrap items-center gap-4" aria-label="Footer">
					<Link className="no-underline hover:text-fg-muted" to="/docs">
						Docs
					</Link>
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
