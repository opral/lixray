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
		<div className="min-h-screen bg-bg font-sans text-fg antialiased">
			<SiteHeader />

			<main className="mx-auto flex w-full max-w-[660px] flex-col gap-16 px-6 pt-16 pb-[130px] sm:px-8 sm:pt-20">
				<section
					className="flex flex-col items-start gap-[22px]"
					aria-labelledby="landing-title"
				>
					<h1
						className="m-0 text-[clamp(2.25rem,5.5vw,2.875rem)] leading-[1.12] font-bold tracking-[-.03em] text-balance"
						id="landing-title"
					>
						All your work.
						<span className="block">In one repository.</span>
					</h1>
					<p className="m-0 text-lg leading-[1.6] text-fg-muted text-pretty">
						Files and application data, like customer and order tables, share
						one version history. Agents and services can propose changes for
						checks and review.
					</p>
					<div className="mt-0.5 flex flex-wrap items-center gap-3">
						<a className={primaryButton} href={repositoryTo}>
							{heroCtaLabel}
						</a>
					</div>
					<div className="flex flex-wrap items-center gap-[9px] text-sm text-fg-subtle">
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
					<div className="mt-5 w-full self-stretch overflow-hidden rounded-xl border border-fg/12 bg-panel text-[13.5px]">
						<div className="flex items-center gap-2 border-b border-fg/8 bg-bg-hover px-5 py-2.5 font-mono text-[12.5px] text-fg-subtle">
							lixray.com/<b className="text-fg">@acme/repository</b>
						</div>
						<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 px-5 pt-2 pb-3">
							<span className={repoColumnHeading}>Name</span>
							<span className={repoColumnHeading}>Author</span>
							{repoItems.map((item) => (
								<RepoItemRow key={item.name} {...item} />
							))}
						</div>
					</div>
				</section>

				<section
					className="flex flex-col gap-[18px]"
					aria-labelledby="why-title"
				>
					<h2
						className="m-0 text-2xl font-bold tracking-[-.02em]"
						id="why-title"
					>
						Why a repository?
					</h2>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						Putting open-format files and application data in one repository
						lets tools and services interoperate. Adding version control on top
						leads to an automation layer with built-in reviews.
					</p>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
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
					className="flex flex-col gap-[18px]"
					aria-labelledby="comparison-title"
				>
					<h2
						className="m-0 text-2xl font-bold tracking-[-.02em]"
						id="comparison-title"
					>
						How it compares
					</h2>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						<a
							className="text-fg-muted underline decoration-fg-muted/30 underline-offset-2 hover:text-link hover:decoration-link/40"
							href="https://inlang.com/blog/update-on-inlang-v2"
						>
							<b>GitHub</b> has version control, but application data lives
							outside the repository.
						</a>
					</p>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						<b>Notion</b> uses proprietary pages, not a filesystem. Uploaded
						code, Excel, Word, and media files cannot be edited in place.
					</p>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						<b>Google Drive</b> stores files, but has no database tables for
						application data or version control across files.
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
	"pt-2 pb-1.5 text-[11.5px] font-semibold tracking-[.03em] text-fg-faint uppercase";

type RepoItem = {
	name: string;
	icon?: string;
	rows?: string;
	author: string;
	/** Agent brand mark shown before the author; people have none. */
	authorIcon?: string;
};

const repoItems: RepoItem[] = [
	{ name: "brand", icon: "icon-folder", author: "Anna" },
	{ name: "handbook.md", icon: "icon-sq-md", author: "Anna" },
	{
		name: "crm-sync.py",
		icon: "icon-sq-py",
		author: "Claude",
		authorIcon: "claude-spark",
	},
	{
		name: "launch-deck.pdf",
		icon: "icon-sq-pdf",
		author: "Tom",
	},
	{
		name: "launch-video.mp4",
		icon: "icon-sq-mp4",
		author: "ChatGPT",
		authorIcon: "brand-openai",
	},
	{
		name: "orders",
		rows: "12,400 rows",
		author: "Claude",
		authorIcon: "claude-spark",
	},
	{
		name: "customers",
		rows: "3,180 rows",
		author: "Anna",
	},
];

function RepoItemRow({ name, icon, rows, author, authorIcon }: RepoItem) {
	return (
		<>
			<span
				className="inline-flex min-w-0 items-center gap-2.5 border-t border-fg/6 py-2 font-medium"
				aria-label={rows ? `${name}, table with ${rows}` : undefined}
			>
				{icon ? (
					<img
						className="size-[18px] shrink-0"
						src={`/landing/${icon}.svg`}
						alt=""
					/>
				) : (
					<Table2
						className="size-[18px] shrink-0 text-fg-subtle"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
				)}
				<span className="truncate">{name}</span>
				{rows ? (
					<span className="ml-auto hidden shrink-0 text-xs font-normal text-fg-subtle min-[480px]:inline">
						{rows}
					</span>
				) : null}
			</span>
			<span className="inline-flex items-center gap-[7px] border-t border-fg/6 py-2 whitespace-nowrap text-fg-muted">
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
