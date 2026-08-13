import { Link } from "@tanstack/react-router";
import { ArrowRight, Building2, type LucideIcon, User, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SiteHeader, useWorkspaceCta } from "~/components/site-header";

const primaryButton =
	"inline-flex items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-[22px] py-3 text-base font-bold whitespace-nowrap text-white no-underline shadow-[0_6px_16px_rgba(232,89,12,.3),inset_0_1px_0_rgba(255,255,255,.25)] transition hover:brightness-105";
const secondaryButton =
	"inline-flex items-center justify-center rounded-[10px] border border-[#1c1917]/15 bg-white px-5 py-[11px] text-base font-semibold whitespace-nowrap text-[#1c1917] no-underline transition hover:border-[#1c1917]/30";
const bookDemoHref = "mailto:hello@opral.com?subject=LixRay%20demo";

export function LandingPage() {
	const { authLoaded, user, workspaceState, workspaceTo } = useWorkspaceCta();
	const [audience, setAudience] = useState<"individual" | "company">("company");
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

	const ctaRow = (
		<div className="flex flex-wrap items-center gap-3">
			<a className={primaryButton} href={workspaceTo}>
				{heroCtaLabel}
			</a>
			<a className={secondaryButton} href={bookDemoHref}>
				Book a demo
			</a>
		</div>
	);

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

			<main className="mx-auto flex w-full max-w-[660px] flex-col gap-16 px-6 pt-16 pb-[130px] sm:px-8 sm:pt-20">
				<section
					className="flex flex-col items-start gap-[22px]"
					aria-labelledby="landing-title"
				>
					<div
						className="flex items-center gap-5 text-sm"
						role="group"
						aria-label="Pitch audience"
					>
						<AudienceButton
							active={audience === "company"}
							Icon={Building2}
							onClick={() => setAudience("company")}
						>
							Company
						</AudienceButton>
						<AudienceButton
							active={audience === "individual"}
							Icon={User}
							onClick={() => setAudience("individual")}
						>
							Individual
						</AudienceButton>
					</div>
					{/* Both pitches are server-rendered so crawlers and agents see them
					    without pressing the toggle; the inactive one is hidden. */}
					<h1
						className="m-0 text-[clamp(2.25rem,5.5vw,2.875rem)] leading-[1.12] font-bold tracking-[-.03em] text-balance"
						id="landing-title"
						hidden={audience !== "company"}
					>
						A repository for your entire company
					</h1>
					<h1
						className="m-0 text-[clamp(2.25rem,5.5vw,2.875rem)] leading-[1.12] font-bold tracking-[-.03em] text-balance"
						hidden={audience !== "individual"}
					>
						A repository for you and your agents
					</h1>
					<p
						className="m-0 text-lg leading-[1.6] text-[#57534e] text-pretty"
						hidden={audience !== "company"}
					>
						One repo your team and your agents share. Any file type, every
						change tracked.
					</p>
					<p
						className="m-0 text-lg leading-[1.6] text-[#57534e] text-pretty"
						hidden={audience !== "individual"}
					>
						One repo you and your agents share. Any file type, every change
						tracked.
					</p>
					<div className="mt-0.5">{ctaRow}</div>
					<div className="flex flex-wrap items-center gap-[9px] text-sm text-[#8a8178]">
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
					<div className="w-full self-stretch overflow-hidden rounded-xl border border-[#1c1917]/12 bg-white">
						<div className="flex items-center gap-2 border-b border-[#1c1917]/8 bg-[#f7f3ed] px-5 py-2.5 font-mono text-[12.5px] text-[#8a8178]">
							lixray.com/<b className="text-[#1c1917]">@acme/repository</b>
						</div>
						<div className="flex flex-col gap-2.5 px-6 py-5 font-mono text-[13.5px]">
							<RepoRow folder="sales/">
								playbook.md · icp.md · leads.csv
							</RepoRow>
							<RepoRow folder="brand/">
								logo.png · launch-video.mp4 · deck.pdf
							</RepoRow>
							<RepoRow folder="skills/">
								call-prep/SKILL.md · research/SKILL.md
							</RepoRow>
							<RepoRow folder="automations/">
								crm-sync.py · weekly-report.js
							</RepoRow>
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
						Why?
					</h2>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Sharing skills.</b> Write a skill once. Every agent on the team
						runs the same version.
					</p>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Storing automations.</b> The scripts your agents run on a
						schedule, versioned and reviewable.
					</p>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Context layer for agents.</b> Agents read the ICP and the
						playbook from one place. Always the current version.
					</p>
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
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<Link
							className="text-[#44403c] underline decoration-[#44403c]/30 underline-offset-2 hover:text-[#e8590c] hover:decoration-[#e8590c]/40"
							to="/lp/lixray-vs-github"
						>
							<b>GitHub</b> is too technical (branch, commit, pull request) and
							lacks permissions.
						</Link>
					</p>
					<p className="m-0 text-base leading-[1.65] text-[#44403c]">
						<b>Google Drive</b> has no version control and is not designed for
						programmatic usage.
					</p>
				</section>
			</main>

			<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[#1c1917]/7 px-5 py-6 text-sm text-[#8a8178] sm:px-14">
				<span className="inline-flex items-center gap-2">
					<img className="size-4" src="/lixray-mark.svg" alt="" />
					<span className="font-semibold text-[#57534e]">LixRay</span>
				</span>
				<a
					className="no-underline hover:text-[#57534e]"
					href="https://opral.com"
					target="_blank"
					rel="noreferrer"
				>
					© 2026 Opral
				</a>
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

function AudienceButton({
	active,
	Icon,
	onClick,
	children,
}: {
	active: boolean;
	Icon: LucideIcon;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			className={
				active
					? "inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-semibold text-[#1c1917]"
					: "inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[#8a8178] hover:text-[#1c1917]"
			}
			type="button"
			aria-pressed={active}
			onClick={onClick}
		>
			<Icon
				className="size-4"
				strokeWidth={active ? 2.4 : 2}
				aria-hidden="true"
			/>
			{children}
		</button>
	);
}

function RepoRow({
	folder,
	children,
}: {
	folder: string;
	children: ReactNode;
}) {
	return (
		<span className="flex flex-col gap-0.5 sm:flex-row sm:gap-3.5">
			<span className="w-[130px] shrink-0 font-bold text-[#c2410c]">
				{folder}
			</span>
			<span className="text-[#8a8178]">{children}</span>
		</span>
	);
}
