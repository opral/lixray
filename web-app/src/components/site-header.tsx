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
 * The marketing-surface navbar shared by the landing page and the docs site:
 * "LixRay | Docs" on the left, GitHub / auth / CTA on the right.
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
				"z-20 flex items-center justify-between px-5 py-6 sm:px-14",
				sticky ? "sticky top-0 border-b border-fg/8 bg-bg" : "relative",
			)}
		>
			<div className="flex items-center gap-[18px]">
				<Link
					className="inline-flex items-center gap-[9px] text-lg font-bold tracking-[-.01em] text-fg no-underline"
					to="/"
					aria-label="LixRay home"
				>
					<img className="size-[26px]" src="/lixray-mark.svg" alt="" />
					<span>LixRay</span>
				</Link>
				<span
					className="h-[18px] w-px bg-overlay/15 max-[400px]:hidden"
					aria-hidden="true"
				/>
				<Link
					className="text-[15px] font-semibold text-fg-muted no-underline hover:text-fg max-[400px]:hidden"
					to="/docs"
				>
					Docs
				</Link>
				<a
					className="hidden text-[15px] font-semibold text-fg-muted no-underline hover:text-fg sm:block"
					href="https://github.com/opral"
					target="_blank"
					rel="noreferrer"
				>
					GitHub ↗
				</a>
			</div>
			<nav
				className="flex items-center gap-5 text-[15px] font-semibold whitespace-nowrap sm:gap-6"
				aria-label="Primary navigation"
			>
				{user ? (
					<button
						className="cursor-pointer border-0 bg-transparent p-0 text-fg hover:text-link"
						type="button"
						onClick={() => void signOut()}
					>
						Log out
					</button>
				) : (
					<a className="text-fg no-underline" href="/sign-in">
						Sign in
					</a>
				)}
				<a
					className="rounded-[10px] border border-fg/15 bg-panel px-[18px] py-2.5 font-semibold text-fg no-underline transition hover:border-fg/30"
					href={repositoryTo}
				>
					{user ? "Open LixRay" : "Get started"}
				</a>
			</nav>
			{children}
		</header>
	);
}
