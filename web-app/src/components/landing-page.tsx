import { Link } from "@tanstack/react-router";
import {
	FileText,
	History,
	LayoutGrid,
	Plus,
	Table2,
	Upload,
	Waypoints,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	SiteFooter,
	SiteHeader,
	useRepositoryCta,
} from "~/components/site-header";

const iconPath = (name: string) => "/landing/" + name;

export const primaryButton =
	"inline-flex min-h-[48px] items-center justify-center rounded-[10px] bg-[image:var(--atelier-accent-gradient)] px-6 text-[16px] font-bold whitespace-nowrap text-accent-on no-underline shadow-accent transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const secondaryButton =
	"inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[10px] border border-fg/15 bg-panel px-5 text-[16px] font-semibold whitespace-nowrap text-fg no-underline transition hover:border-fg/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const sectionTitle =
	"m-0 flex flex-wrap items-center gap-3 text-[28px] leading-[1.2] font-bold tracking-[-.02em] text-balance";
const sectionText = "m-0 text-[17px] leading-[1.65] text-fg-muted";

/** Public tracking issue for source connectors; the "Soon" badge links here. */
const sourcesIssueHref = "https://github.com/opral/lix/issues/1934";

export function SoonBadge({ href }: { href?: string }) {
	const className =
		"rounded-full border border-accent-border bg-accent-subtle px-2.5 py-0.5 text-[12px] font-bold tracking-[.02em] text-accent no-underline";
	return href ? (
		<a className={className} href={href} target="_blank" rel="noreferrer">
			Soon
		</a>
	) : (
		<span className={className}>Soon</span>
	);
}

function BrandIcon({ name, alt = "" }: { name: string; alt?: string }) {
	return (
		<img
			className="size-4 shrink-0 object-contain"
			src={iconPath(name)}
			alt={alt}
		/>
	);
}

function NavItem({
	icon,
	children,
	active = false,
	muted = false,
}: {
	icon: ReactNode;
	children: ReactNode;
	active?: boolean;
	muted?: boolean;
}) {
	return (
		<div
			className={
				"flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 " +
				(active
					? "bg-bg-hover font-semibold text-fg"
					: muted
						? "text-fg-subtle"
						: "text-fg-muted")
			}
		>
			{icon}
			{children}
		</div>
	);
}

const navIcon = "size-[15px] shrink-0";

const previewRows = [
	{
		name: "customers",
		table: true,
		author: "Claude",
		authorIcon: "claude-spark.svg",
	},
	{
		name: "orders",
		table: true,
		author: "ChatGPT",
		authorIcon: "brand-openai.svg",
	},
	{
		name: "research",
		icon: "icon-folder.svg",
		author: "Claude",
		authorIcon: "claude-spark.svg",
	},
	{
		name: "roadmap.md",
		icon: "icon-sq-md.svg",
		author: "ChatGPT",
		authorIcon: "brand-openai.svg",
	},
	{ name: "budget.xlsx", icon: "icon-sq-xlsx.svg", author: "You" },
	{ name: "pitch-deck.pdf", icon: "icon-sq-pdf.svg", author: "You" },
] as const;

/** Simplified app window: a repository with tables and files, plus one agent change to review. */
function ProductPreview() {
	return (
		<figure
			className="m-0 overflow-hidden rounded-[14px] border border-border bg-panel text-left shadow-lg"
			aria-label="LixRay app showing a repository with tables and files. Claude changed one row in the customers table and the change waits for Keep or Undo."
		>
			<div className="flex items-center gap-3 border-b border-border-subtle bg-bg-subtle px-3.5 py-2.5 font-mono text-[12.5px] text-fg-subtle">
				<span className="flex gap-1.5" aria-hidden="true">
					<i className="size-2.5 rounded-full bg-fg/12" />
					<i className="size-2.5 rounded-full bg-fg/12" />
					<i className="size-2.5 rounded-full bg-fg/12" />
				</span>
				lixray.com
			</div>
			<div className="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)]">
				<aside className="hidden flex-col gap-0.5 border-r border-border-subtle px-2.5 py-4 text-[14px] md:flex">
					<div className="flex items-center gap-2 px-2.5 pb-3 text-[15px] font-bold">
						<img className="size-[18px]" src="/lixray-mark.svg" alt="" />
						home
					</div>
					<NavItem
						active
						icon={<LayoutGrid className={navIcon} strokeWidth={1.7} />}
					>
						All
					</NavItem>
					<NavItem icon={<FileText className={navIcon} strokeWidth={1.7} />}>
						Documents
					</NavItem>
					<NavItem icon={<Table2 className={navIcon} strokeWidth={1.7} />}>
						Tables
					</NavItem>
					<NavItem icon={<History className={navIcon} strokeWidth={1.7} />}>
						History
					</NavItem>
					<SidebarLabel>Sources</SidebarLabel>
					<NavItem icon={<BrandIcon name="brand-google-drive.svg" />}>
						Google Drive
					</NavItem>
					<NavItem icon={<BrandIcon name="brand-notion.svg" />}>Notion</NavItem>
					<NavItem muted icon={<Plus className={navIcon} strokeWidth={1.7} />}>
						Connect source
					</NavItem>
					<SidebarLabel>Agents</SidebarLabel>
					<NavItem icon={<BrandIcon name="claude-spark.svg" />}>Claude</NavItem>
					<NavItem icon={<BrandIcon name="brand-openai.svg" />}>
						ChatGPT
					</NavItem>
				</aside>
				<div className="flex min-w-0 flex-col gap-2.5 px-5 pt-5 pb-6 sm:px-6">
					<div className="flex items-center justify-between gap-3">
						<strong className="text-[22px] font-semibold tracking-[-.01em]">
							All
						</strong>
						<span className="rounded-full bg-fg px-3.5 py-1 text-[13px] font-semibold text-panel">
							New ▾
						</span>
					</div>
					<div className="text-[14.5px]">
						<div className="flex justify-between border-b border-border py-1.5 text-[12.5px] text-fg-subtle">
							<span>Name</span>
							<span>Changed by</span>
						</div>
						{previewRows.map((row) => (
							<div
								key={row.name}
								className="flex items-center justify-between gap-3 border-b border-border-subtle py-2"
							>
								<span className="flex min-w-0 items-center gap-2.5 font-medium">
									{"table" in row ? (
										<Table2
											className="size-[22px] shrink-0 text-fg-subtle"
											strokeWidth={1.4}
											aria-hidden="true"
										/>
									) : (
										<img
											className="size-[22px] shrink-0"
											src={iconPath(row.icon)}
											alt=""
										/>
									)}
									<span className="truncate">{row.name}</span>
								</span>
								<span className="inline-flex shrink-0 items-center gap-1.5 text-[14px] text-fg-muted">
									{"authorIcon" in row && <BrandIcon name={row.authorIcon} />}
									{row.author}
								</span>
							</div>
						))}
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-[10px] border border-border bg-bg-subtle px-3.5 py-3 text-[14px]">
						<span className="inline-flex items-center gap-1.5 text-fg-muted">
							<BrandIcon name="claude-spark.svg" />
							<strong className="text-fg">Claude</strong> changed 1 row in
							customers
						</span>
						<table className="min-w-[160px] flex-1 border-collapse overflow-hidden rounded-lg border border-border-subtle bg-panel font-mono text-[13px]">
							<thead>
								<tr className="text-left text-fg-subtle">
									<th className="border-b border-border px-2.5 py-1 font-normal">
										name
									</th>
									<th className="border-b border-border px-2.5 py-1 font-normal">
										plan
									</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td className="px-2.5 py-1">Acme</td>
									<td className="px-2.5 py-1">
										<del className="mr-1.5 rounded bg-danger-subtle px-1 text-danger">
											trial
										</del>
										<ins className="rounded bg-success-subtle px-1 text-success no-underline">
											paid
										</ins>
									</td>
								</tr>
							</tbody>
						</table>
						<span className="ml-auto flex gap-2">
							<span className="rounded-lg bg-fg px-3.5 py-1.5 font-semibold text-panel">
								Keep
							</span>
							<span className="rounded-lg border border-border bg-panel px-3.5 py-1.5 font-semibold">
								Undo
							</span>
						</span>
					</div>
				</div>
			</div>
		</figure>
	);
}

function SidebarLabel({ children }: { children: ReactNode }) {
	return (
		<div className="mx-2.5 mt-4 mb-1 text-[11.5px] font-semibold tracking-[.06em] text-fg-subtle uppercase">
			{children}
		</div>
	);
}

const sources = [
	{ label: "Google Drive", icon: <BrandIcon name="brand-google-drive.svg" /> },
	{ label: "Notion", icon: <BrandIcon name="brand-notion.svg" /> },
	{ label: "GitHub", icon: <BrandIcon name="brand-github.svg" /> },
	{ label: "Granola", icon: <BrandIcon name="brand-granola.png" /> },
	{
		label: "Upload",
		icon: (
			<Upload
				className="size-4 shrink-0"
				strokeWidth={1.7}
				aria-hidden="true"
			/>
		),
	},
];

const agents = [
	{ label: "Claude", icon: <BrandIcon name="claude-spark.svg" /> },
	{ label: "ChatGPT", icon: <BrandIcon name="brand-openai.svg" /> },
	{ label: "Gemini", icon: <BrandIcon name="brand-gemini.svg" /> },
	{
		label: "Any MCP agent",
		icon: (
			<Waypoints
				className="size-4 shrink-0"
				strokeWidth={1.7}
				aria-hidden="true"
			/>
		),
	},
];

/** Connector lines fanning from evenly spaced rows into one centre point. */
function Wires({ count, flip = false }: { count: number; flip?: boolean }) {
	const d = Array.from({ length: count }, (_, i) => {
		const y = ((i + 0.5) / count) * 100;
		return flip ? `M64 ${y}C32 ${y} 32 50 0 50` : `M0 ${y}C32 ${y} 32 50 64 50`;
	}).join("");
	return (
		<svg
			className="hidden h-full w-full overflow-visible text-fg/25 sm:block"
			viewBox="0 0 64 100"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<path
				d={d}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

function ChipStack({
	items,
	rowsClassName,
}: {
	items: { label: string; icon: ReactNode }[];
	/** Equal-height rows on wide screens, so the wires meet each chip's centre. */
	rowsClassName: string;
}) {
	return (
		<div
			className={
				"grid grid-cols-2 gap-2 sm:grid-cols-1 sm:gap-0 " + rowsClassName
			}
		>
			{items.map(({ label, icon }) => (
				<div key={label} className="flex items-center sm:py-[5px]">
					<span className="flex flex-1 items-center gap-2.5 rounded-[9px] border border-border bg-panel px-3 py-2 text-[14px] font-semibold">
						{icon}
						{label}
					</span>
				</div>
			))}
		</div>
	);
}

function SourcesDiagram() {
	return (
		<div
			className="mt-2 grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[minmax(0,1fr)_64px_auto_64px_minmax(0,1fr)] sm:gap-0"
			role="img"
			aria-label="Google Drive, Notion, GitHub, Granola and uploads flow into LixRay. Claude, ChatGPT, Gemini and any MCP agent read and edit it."
		>
			<ChipStack items={sources} rowsClassName="sm:grid-rows-5" />
			<Wires count={sources.length} />
			<div className="flex flex-col items-center justify-center gap-2 py-2 text-[15px] font-bold">
				<img
					className="size-14 drop-shadow-[0_8px_14px_rgba(232,89,12,.28)]"
					src="/lixray-mark.svg"
					alt=""
				/>
				LixRay
			</div>
			<Wires count={agents.length} flip />
			<ChipStack items={agents} rowsClassName="sm:grid-rows-4" />
		</div>
	);
}

export function LandingPage() {
	const { user, repositoryTo } = useRepositoryCta();
	const ctaLabel = user ? "Open LixRay" : "Create a repository";

	return (
		<div className="min-h-screen bg-bg font-sans text-fg antialiased">
			<SiteHeader />
			<main>
				<section
					className="flex flex-col items-center gap-[22px] px-6 pt-14 text-center sm:pt-16"
					aria-labelledby="landing-title"
				>
					<h1
						id="landing-title"
						className="m-0 max-w-[16ch] text-[clamp(2.4rem,6.4vw,4rem)] leading-[1.05] font-bold tracking-[-.035em] text-balance"
					>
						Shared repository for you and your{" "}
						<span className="text-accent">AI&nbsp;agents</span>
					</h1>
					<p className="m-0 max-w-[600px] text-[18px] leading-[1.6] text-fg-muted text-pretty">
						LixRay connects all your data in one place. Claude, ChatGPT, or any
						MCP agent reads and edits the same data, with full version control.
					</p>
					<div className="flex flex-wrap justify-center gap-3">
						<a className={primaryButton} href={repositoryTo}>
							{ctaLabel}
						</a>
						<a
							className={secondaryButton}
							href="https://github.com/opral/lix"
							target="_blank"
							rel="noreferrer"
						>
							<img
								className="size-4"
								src={iconPath("brand-github.svg")}
								alt=""
							/>
							Star on GitHub
						</a>
					</div>
					<div className="flex flex-wrap items-center justify-center gap-2.5 text-[14px] text-fg-muted">
						<span>Works with</span>
						<span
							className="inline-flex items-center gap-[9px]"
							aria-label="Claude, ChatGPT, and Gemini"
						>
							<img
								className="size-4"
								src={iconPath("claude-spark.svg")}
								alt=""
							/>
							<img
								className="size-4"
								src={iconPath("brand-openai.svg")}
								alt=""
							/>
							<img
								className="size-4"
								src={iconPath("brand-gemini.svg")}
								alt=""
							/>
						</span>
						<span>and any MCP agent</span>
					</div>
				</section>

				<section
					className="mx-auto mt-12 w-full max-w-[1000px] px-4 sm:px-6"
					aria-label="Product preview"
				>
					<ProductPreview />
				</section>

				<div className="mx-auto flex w-full max-w-[680px] flex-col px-6 pb-[120px]">
					<section
						className="flex flex-col gap-[18px] pt-24"
						aria-labelledby="sources-title"
					>
						<h2 id="sources-title" className={sectionTitle}>
							Connect your sources <SoonBadge href={sourcesIssueHref} />
						</h2>
						<p className={sectionText}>
							Pull in files from Google Drive, Notion, GitHub, and Granola, or
							upload them. Agents read from one place instead of each tool's
							API.
						</p>
						<SourcesDiagram />
					</section>

					<section
						className="flex flex-col gap-[18px] pt-24"
						aria-labelledby="why-title"
					>
						<h2 id="why-title" className={sectionTitle}>
							Why LixRay
						</h2>
						<ul className="m-0 flex list-disc flex-col gap-3.5 pl-5 text-[17px] leading-[1.6] text-fg-muted">
							<li>
								<strong className="text-fg">
									All data for agents in one place.
								</strong>{" "}
								Documents, files, and database tables live in one repository.
							</li>
							<li>
								<strong className="text-fg">No vendor lock-in.</strong>
								<ul className="mt-1.5 flex list-[circle] flex-col gap-1 pl-5">
									<li>Works with Claude, ChatGPT, Gemini, or any MCP agent.</li>
									<li>
										Built on{" "}
										<a
											className="text-fg-muted underline underline-offset-2"
											href="https://github.com/opral/lix"
											target="_blank"
											rel="noreferrer"
										>
											Lix
										</a>
										, open-source (MIT) infrastructure.{" "}
										<Link
											className="text-fg-muted underline underline-offset-2"
											to="/docs/$slug"
											params={{ slug: "self-host" }}
										>
											Self-host it
										</Link>{" "}
										if you want.
									</li>
									<li>
										Open formats first: Markdown, CSV, Excel, and plain SQL
										tables.
									</li>
								</ul>
							</li>
							<li>
								<strong className="text-fg">Version control.</strong>
								<ul className="mt-1.5 flex list-[circle] flex-col gap-1 pl-5">
									<li>
										Change proposals: agents propose changes without breaking
										your work.
									</li>
									<li>
										History: agents learn from past changes, and you can trace
										who changed what.
									</li>
									<li>
										<span className="inline-flex items-center gap-2">
											Automations <SoonBadge />
										</span>
									</li>
								</ul>
							</li>
						</ul>
					</section>

					<section
						className="flex flex-col gap-[18px] pt-24"
						aria-labelledby="comparison-title"
					>
						<h2 id="comparison-title" className={sectionTitle}>
							Compared to
						</h2>
						<div className="flex flex-col gap-3.5 text-[17px] leading-[1.6] text-fg-muted">
							<p className="m-0 flex items-start gap-3">
								<span className="mt-[5px]">
									<BrandIcon name="brand-openai.svg" />
								</span>
								<span>
									<strong className="text-fg">ChatGPT Space</strong> only works
									with ChatGPT.
								</span>
							</p>
							<p className="m-0 flex items-start gap-3">
								<span className="mt-[5px]">
									<BrandIcon name="claude-spark.svg" />
								</span>
								<span>
									<strong className="text-fg">Anthropic Artifacts</strong> only
									work with Claude.
								</span>
							</p>
						</div>
						<p className="m-0 text-[15px] text-fg-subtle">
							Notion, Google Drive, and GitHub are not alternatives. LixRay
							connects to them as sources.
						</p>
					</section>

					<section
						className="flex flex-col items-center gap-[18px] pt-24 text-center"
						aria-labelledby="cta-title"
					>
						<h2 id="cta-title" className={sectionTitle}>
							Create your first repository
						</h2>
						<div className="flex flex-wrap justify-center gap-3">
							<a className={primaryButton} href={repositoryTo}>
								{ctaLabel}
							</a>
							<Link className={secondaryButton} to="/docs">
								Read the docs
							</Link>
						</div>
					</section>
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}
