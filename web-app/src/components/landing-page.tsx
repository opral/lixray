import { Link } from "@tanstack/react-router";
import { Table2 } from "lucide-react";
import { SiteHeader, useRepositoryCta } from "~/components/site-header";
import { WhyRepositoryIllustration } from "~/components/why-repository-illustration";

const primaryButton =
	"inline-flex items-center justify-center rounded-[10px] bg-[image:var(--atelier-accent-gradient)] px-[22px] py-3 text-base font-bold whitespace-nowrap text-accent-on no-underline shadow-accent transition hover:brightness-105";

export function LandingPage() {
	const { user, repositoryTo } = useRepositoryCta();
	const heroCtaLabel = user ? "Open LixRay" : "Create your repo for free";

	return (
		<div
			className="min-h-screen bg-bg text-fg antialiased"
			style={{
				fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
			}}
		>
			<SiteHeader />

			<main className="mx-auto flex w-full max-w-[800px] flex-col px-6 pt-12 pb-[120px] sm:px-8 sm:pt-14">
				<section
					className="flex flex-col items-start"
					aria-labelledby="landing-title"
				>
					<h1
						className="m-0 text-[clamp(2.5rem,6vw,3.625rem)] leading-[1.05] font-bold tracking-[-.04em] max-[360px]:text-[34px]"
						id="landing-title"
					>
						All your work.
						<span className="block">In one repository.</span>
					</h1>
					<p className="mt-7 mb-0 text-[19px] leading-[1.6] text-fg-muted text-pretty">
						Files and application data, like customer and order tables, share
						one version history. Agents and services can propose changes for
						checks and review.
					</p>
					<div className="mt-[30px] flex flex-wrap items-center gap-3">
						<a className={primaryButton} href={repositoryTo}>
							{heroCtaLabel}
						</a>
					</div>
					<div className="mt-[26px] flex flex-wrap items-center gap-2.5 text-[15px] text-fg-subtle">
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
					<div className="mt-16 w-full self-stretch overflow-hidden rounded-[14px] border border-fg/12 bg-panel text-base shadow-lg">
						<div className="flex items-center gap-2 border-b border-fg/8 bg-bg-hover px-6 py-3.5 font-mono text-sm text-fg-subtle">
							lixray.com/<b className="text-fg">@acme/repository</b>
						</div>
						<div className="border-b border-fg/8 px-5 pt-[18px] pb-2.5 sm:px-6">
							<div
								className="relative flex h-[52px] items-start justify-center sm:hidden"
								role="img"
								aria-label="Claude proposes changes to the repository"
							>
								<span
									className="absolute right-0 bottom-2 left-0 border-b border-fg"
									aria-hidden="true"
								/>
								<span className="relative z-10 inline-flex items-center gap-1.5 rounded-full bg-panel px-3 py-1 text-xs whitespace-nowrap">
									<img
										className="size-3"
										src="/landing/claude-spark.svg"
										alt=""
									/>
									<b>Claude</b> proposes changes
								</span>
							</div>
							<svg
								viewBox="0 0 640 52"
								className="hidden w-full sm:block"
								aria-label="Claude proposes changes to the repository"
								role="img"
							>
								<path
									d="M0 44 H640"
									stroke="currentColor"
									strokeWidth="1.8"
									fill="none"
								/>
								<path
									d="M200 44 C220 44 212 16 232 16 H432 C452 16 444 44 464 44"
									stroke="var(--atelier-link)"
									strokeWidth="1.8"
									fill="none"
									strokeLinecap="round"
								/>
								<rect
									x="240"
									y="4"
									width="184"
									height="24"
									rx="12"
									fill="var(--atelier-panel)"
								/>
								<image
									href="/landing/claude-spark.svg"
									x="249"
									y="10"
									width="12"
									height="12"
								/>
								<text x="267" y="20" fontSize="12" fill="var(--atelier-fg)">
									<tspan fontWeight="700">Claude</tspan>
									<tspan fill="var(--atelier-fg-muted)">
										{" "}
										proposes changes
									</tspan>
								</text>
								{[80, 200, 464, 570].map((x) => (
									<circle key={x} cx={x} cy="44" r="4" fill="currentColor" />
								))}
							</svg>
						</div>
						<div className="grid grid-cols-[minmax(0,1fr)_85px] gap-x-4 px-5 pt-2 pb-4 sm:grid-cols-[minmax(0,1fr)_130px] sm:gap-x-6 sm:px-6">
							<span className={repoColumnHeading}>Name</span>
							<span className={repoColumnHeading}>Author</span>
							{repoItems.map((item) => (
								<RepoItemRow key={item.name} {...item} />
							))}
						</div>
					</div>
				</section>

				<section
					className="mt-[104px] flex flex-col gap-5"
					aria-labelledby="why-title"
				>
					<h2
						className="m-0 text-[30px] leading-[normal] font-bold tracking-[-.02em]"
						id="why-title"
					>
						Why a repository?
					</h2>
					<p className="m-0 text-lg leading-[1.65] text-fg-muted">
						Putting open-format files and application data in one repository
						lets tools and services interoperate. Adding version control on top
						leads to an automation layer with built-in reviews.
					</p>
					<p className="m-0 text-lg leading-[1.65] text-fg-muted">
						Building{" "}
						<a
							className="text-fg-muted underline decoration-fg-muted/30 underline-offset-2 hover:text-link hover:decoration-link/40"
							href="https://inlang.com"
							target="_blank"
							rel="noreferrer"
						>
							inlang
						</a>{" "}
						showed us a better way to deliver a product: plug into the
						customer’s repository, work on their data, and use their CI/CD and
						pull requests for automation and review. But Git cannot store
						application data as tables in the repository. That became our main
						limitation and led us to build{" "}
						<a
							className="text-fg-muted underline decoration-fg-muted/30 underline-offset-2 hover:text-link hover:decoration-link/40"
							href="https://lix.dev"
							target="_blank"
							rel="noreferrer"
						>
							Lix
						</a>
						{"."}
					</p>
					<WhyRepositoryIllustration />
				</section>

				<section
					className="mt-24 flex flex-col gap-[18px]"
					aria-labelledby="comparison-title"
				>
					<h2
						className="m-0 text-[30px] leading-[normal] font-bold tracking-[-.02em]"
						id="comparison-title"
					>
						How it compares
					</h2>
					<p className="m-0 text-lg leading-[1.65] text-fg-muted">
						<Link
							className="text-fg-muted no-underline hover:text-link hover:underline"
							to="/lp/lixray-vs-github"
						>
							<b>GitHub</b> has version control, but application data lives
							outside the repository.
						</Link>
					</p>
					<p className="m-0 text-lg leading-[1.65] text-fg-muted">
						<b>Notion</b> doesn’t have a file system. Files are only attachments
						and cannot be edited in place.
					</p>
					<p className="m-0 text-lg leading-[1.65] text-fg-muted">
						<b>Google Drive</b> cannot store application data, nor does it have
						version control.
					</p>
				</section>
			</main>

			<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-fg/7 px-5 py-6 text-sm text-fg-subtle sm:px-14">
				<span className="inline-flex items-center gap-2">
					<img className="size-4" src="/landing/lixray-glyph.svg" alt="" />
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

const repoColumnHeading =
	"pt-3.5 pb-2.5 text-[12.5px] font-semibold tracking-[.05em] text-fg-faint uppercase";

type RepoItem = {
	name: string;
	icon?: string;
	author: string;
	/** Agent brand mark shown before the author; people have none. */
	authorIcon?: string;
};

const repoItems: RepoItem[] = [
	{ name: "orders", author: "Tom" },
	{ name: "customers", author: "ChatGPT", authorIcon: "brand-openai" },
	{ name: "brand", icon: "icon-folder", author: "Anna" },
	{ name: "handbook.docx", icon: "icon-sq-docx", author: "Anna" },
	{
		name: "crm-sync.py",
		icon: "icon-sq-py",
		author: "Anna",
	},
	{ name: "roadmap.md", icon: "icon-sq-md", author: "Tom" },
	{
		name: "books.xlsx",
		icon: "icon-sq-xlsx",
		author: "Claude",
		authorIcon: "claude-spark",
	},
	{
		name: "launch-deck.pdf",
		icon: "icon-sq-pdf",
		author: "Tom",
	},
];

function RepoItemRow({ name, icon, author, authorIcon }: RepoItem) {
	return (
		<>
			<span className="inline-flex min-w-0 items-center gap-3.5 border-t border-fg/6 py-[9.5px] font-medium">
				{icon ? (
					<img
						className="size-5 shrink-0"
						src={`/landing/${icon}.svg`}
						alt=""
					/>
				) : (
					<Table2
						className="size-5 shrink-0 text-fg-subtle"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
				)}
				<span className="truncate">{name}</span>
			</span>
			<span className="inline-flex items-center gap-2 border-t border-fg/6 py-[9.5px] whitespace-nowrap text-fg-muted">
				{authorIcon ? (
					<img
						className="size-[13px] shrink-0 object-contain"
						src={`/landing/${authorIcon}.svg`}
						alt=""
					/>
				) : (
					<span className="size-[13px] shrink-0" aria-hidden="true" />
				)}
				{author}
			</span>
		</>
	);
}
