import { Link } from "@tanstack/react-router";
import { SiteHeader, useRepositoryCta } from "~/components/site-header";

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
						Version control, made simple.
					</h1>
					<p className="m-0 text-lg leading-[1.6] text-fg-muted text-pretty">
						A repository for any file type. Every change is tracked and
						reversible. Shared with your team and your agents.
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
							<span className={repoColumnHeading}>Last change</span>
							{repoFiles.map((file) => (
								<RepoFileRow key={file.name} {...file} />
							))}
						</div>
					</div>
				</section>

				<section
					className="flex flex-col gap-[18px]"
					aria-labelledby="comparison-title"
				>
					<h2
						className="m-0 text-2xl font-bold tracking-[-.02em]"
						id="comparison-title"
					>
						Comparison
					</h2>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						<Link
							className="text-fg-muted underline decoration-fg-muted/30 underline-offset-2 hover:text-link hover:decoration-link/40"
							to="/lp/lixray-vs-github"
						>
							<b>GitHub</b> is too complicated for non-developers. Branch,
							commit, pull request is designed for software engineers, and
							non-code files are secondary.
						</Link>
					</p>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						<b>Google Drive</b> lacks version control. Per-file history, no
						state across files, so anything with dependencies between files,
						like code, doesn't work.
					</p>
					<p className="m-0 text-base leading-[1.65] text-fg-muted">
						<b>Notion</b> is not file-based. It can't store code and lacks the
						interoperability of files.
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

type RepoFile = {
	name: string;
	icon: string;
	author: string;
	/** Agent brand mark shown before the author; people have none. */
	authorIcon?: string;
	when: string;
};

const repoFiles: RepoFile[] = [
	{ name: "brand", icon: "icon-folder", author: "Anna", when: "Mar 3" },
	{ name: "handbook.md", icon: "icon-sq-md", author: "Anna", when: "1h ago" },
	{
		name: "leads.csv",
		icon: "icon-sq-csv",
		author: "Claude",
		authorIcon: "claude-spark",
		when: "4 min ago",
	},
	{
		name: "crm-sync.py",
		icon: "icon-sq-py",
		author: "Claude",
		authorIcon: "claude-spark",
		when: "2h ago",
	},
	{
		name: "launch-deck.pdf",
		icon: "icon-sq-pdf",
		author: "Tom",
		when: "yesterday",
	},
	{
		name: "launch-video.mp4",
		icon: "icon-sq-mp4",
		author: "ChatGPT",
		authorIcon: "brand-openai",
		when: "Mon",
	},
	{ name: "logo.png", icon: "icon-sq-png", author: "Anna", when: "Mar 3" },
];

function RepoFileRow({ name, icon, author, authorIcon, when }: RepoFile) {
	return (
		<>
			<span className="inline-flex min-w-0 items-center gap-2.5 border-t border-fg/6 py-2 font-medium">
				<img
					className="size-[18px] shrink-0"
					src={`/landing/${icon}.svg`}
					alt=""
				/>
				<span className="truncate">{name}</span>
			</span>
			<span className="inline-flex items-center gap-[7px] border-t border-fg/6 py-2 whitespace-nowrap text-fg-muted">
				{authorIcon ? (
					<img
						className="size-[13px] object-contain"
						src={`/landing/${authorIcon}.svg`}
						alt=""
					/>
				) : null}
				{author} · {when}
			</span>
		</>
	);
}
