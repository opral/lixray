import { Link } from "@tanstack/react-router";
import { primaryButton, secondaryButton } from "~/components/landing-page";
import {
	SiteFooter,
	SiteHeader,
	useRepositoryCta,
} from "~/components/site-header";

export function PricingPage() {
	const { user, repositoryTo } = useRepositoryCta();

	return (
		<div className="min-h-screen bg-bg font-sans text-fg antialiased">
			<SiteHeader />
			<main className="mx-auto flex w-full max-w-[680px] flex-col gap-[18px] px-6 pt-10 pb-[120px]">
				<h1 className="m-0 text-[clamp(2.2rem,5vw,3rem)] leading-[1.1] font-bold tracking-[-.03em]">
					Pricing
				</h1>
				<p className="m-0 text-[18px] leading-[1.6] text-fg-muted">
					Individuals and small teams use LixRay for free. We plan to charge
					large enterprises.
				</p>

				<div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-panel p-[22px]">
						<h2 className="m-0 text-[17px] font-semibold">Self-host</h2>
						<p className="m-0 text-[34px] leading-[1.1] font-bold tracking-[-.02em]">
							Free
						</p>
						<p className="m-0 flex-1 text-[16px] leading-[1.6] text-fg-muted">
							Run the Lix server and the Atelier front end on your own
							infrastructure. Both are open source (MIT).
						</p>
						<Link
							className={secondaryButton + " self-start"}
							to="/docs/$slug"
							params={{ slug: "self-host" }}
						>
							Read the self-host docs
						</Link>
					</div>
					<div className="flex flex-col gap-2.5 rounded-[14px] border border-accent-border bg-panel p-[22px] shadow-accent">
						<h2 className="m-0 text-[17px] font-semibold">LixRay Managed</h2>
						<p className="m-0 text-[34px] leading-[1.1] font-bold tracking-[-.02em]">
							TBD
						</p>
						<p className="m-0 flex-1 text-[16px] leading-[1.6] text-fg-muted">
							We host it for you. Free while we figure out pricing, and we
							expect individuals and small teams to stay free.
						</p>
						<a className={primaryButton + " self-start"} href={repositoryTo}>
							{user ? "Open LixRay" : "Create a repository"}
						</a>
					</div>
				</div>

				<div className="mt-6 flex flex-col gap-1.5 text-[16px] leading-[1.6] text-fg-muted">
					<h2 className="m-0 mt-3.5 text-[16.5px] font-semibold text-fg">
						Will my small team have to pay later?
					</h2>
					<p className="m-0">
						We don't plan to charge individuals or small teams. Revenue is meant
						to come from large enterprises that need things like SSO, audit
						logs, and support contracts. If pricing ever affects you, we will
						tell you well before it applies.
					</p>
					<h2 className="m-0 mt-3.5 text-[16.5px] font-semibold text-fg">
						Large company?
					</h2>
					<p className="m-0">
						Email{" "}
						<a className="font-semibold text-fg" href="mailto:hello@opral.com">
							hello@opral.com
						</a>{" "}
						and we'll talk.
					</p>
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}
