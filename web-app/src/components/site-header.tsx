import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { repositoryCtaHref } from "~/lib/repository-cta";
import { cn } from "~/lib/utils";

/** Auth-aware target and labels for the "open the app" call to action. */
export function useRepositoryCta() {
	const { isLoaded: authLoaded, signOut, user } = useAuth();
	const repositoryState = useRepository();
	const repositoryTo = repositoryCtaHref(Boolean(user));
	return { authLoaded, signOut, user, repositoryState, repositoryTo };
}

/**
 * The marketing-surface navbar shared by the landing, pricing, and docs pages:
 * "LixRay | Docs Pricing Self-host" on the left, auth / CTA on the right.
 */
export function SiteHeader({
	sticky = false,
	children,
}: {
	sticky?: boolean;
	children?: ReactNode;
}) {
	const { signOut, user, repositoryTo } = useRepositoryCta();
	return (
		<header
			className={cn(
				"z-20 flex items-center justify-between gap-4 px-5 py-6 sm:px-14",
				sticky ? "sticky top-0 border-b border-fg/8 bg-bg" : "relative",
			)}
		>
			<div className="flex items-center gap-3.5 sm:gap-[18px]">
				<Link
					className="inline-flex items-center gap-[9px] text-lg font-bold tracking-[-.01em] text-fg no-underline"
					to="/"
					aria-label="LixRay home"
				>
					<img className="size-[26px]" src="/lixray-mark.svg" alt="" />
					<span>LixRay</span>
				</Link>
				<span
					className="hidden h-[18px] w-px bg-overlay/15 sm:block"
					aria-hidden="true"
				/>
				<details className="relative sm:hidden">
					<summary className="cursor-pointer list-none text-[15px] font-semibold whitespace-nowrap text-fg-muted [&::-webkit-details-marker]:hidden">
						Menu ▾
					</summary>
					<div className="absolute top-full left-0 z-30 mt-2 flex min-w-[160px] flex-col gap-1 rounded-[10px] border border-border bg-panel p-2 text-[15px] font-semibold shadow-lg">
						<Link
							className="rounded-md px-2.5 py-2 text-fg no-underline hover:bg-bg-hover"
							to="/docs"
						>
							Docs
						</Link>
						<Link
							className="rounded-md px-2.5 py-2 text-fg no-underline hover:bg-bg-hover"
							to="/pricing"
						>
							Pricing
						</Link>
						<Link
							className="rounded-md px-2.5 py-2 text-fg no-underline hover:bg-bg-hover"
							to="/docs/$slug"
							params={{ slug: "self-host" }}
						>
							Self-host
						</Link>
						<a
							className="rounded-md px-2.5 py-2 text-fg no-underline hover:bg-bg-hover"
							href="https://github.com/opral/lix"
							target="_blank"
							rel="noreferrer"
						>
							GitHub ↗
						</a>
						{user ? (
							<button
								className="cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-2 text-left font-semibold text-fg hover:bg-bg-hover"
								type="button"
								onClick={() => void signOut()}
							>
								Log out
							</button>
						) : (
							<a
								className="rounded-md px-2.5 py-2 text-fg no-underline hover:bg-bg-hover"
								href="/sign-in"
							>
								Sign in
							</a>
						)}
					</div>
				</details>
				<Link
					className="hidden text-[15px] font-semibold text-fg-muted no-underline hover:text-fg sm:block"
					to="/docs"
				>
					Docs
				</Link>
				<Link
					className="hidden text-[15px] font-semibold text-fg-muted no-underline hover:text-fg sm:block"
					to="/pricing"
				>
					Pricing
				</Link>
				<Link
					className="hidden text-[15px] font-semibold text-fg-muted no-underline hover:text-fg sm:block"
					to="/docs/$slug"
					params={{ slug: "self-host" }}
				>
					Self-host
				</Link>
			</div>
			<nav
				className="flex items-center gap-4 text-[15px] font-semibold whitespace-nowrap sm:gap-6"
				aria-label="Primary navigation"
			>
				<a
					className="hidden text-fg-muted no-underline hover:text-fg md:block"
					href="https://github.com/opral/lix"
					target="_blank"
					rel="noreferrer"
				>
					GitHub ↗
				</a>
				{user ? (
					<button
						className="hidden cursor-pointer border-0 bg-transparent p-0 text-fg hover:text-link sm:inline"
						type="button"
						onClick={() => void signOut()}
					>
						Log out
					</button>
				) : (
					<a className="hidden text-fg no-underline sm:inline" href="/sign-in">
						Sign in
					</a>
				)}
				<a
					className="rounded-[10px] border border-fg/15 bg-panel px-3.5 py-2.5 sm:px-[18px] font-semibold text-fg no-underline transition hover:border-fg/30"
					href={repositoryTo}
				>
					{user ? "Open LixRay" : "Get started"}
				</a>
			</nav>
			{children}
		</header>
	);
}

/** The marketing-surface footer shared by the landing and pricing pages. */
export function SiteFooter() {
	return (
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
				<Link className="no-underline hover:text-fg-muted" to="/pricing">
					Pricing
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
	);
}
