import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { cn } from "~/lib/utils";
import { workspacePath } from "~/lib/workspace-url";

/** Auth-aware target and labels for the "open the app" call to action. */
export function useWorkspaceCta() {
	const { isLoaded: authLoaded, signOut, user } = useAuth();
	const workspaceState = useWorkspace();
	const activeWorkspace = workspaceState.activeWorkspace;
	const workspaceTo = user
		? activeWorkspace
			? workspacePath(activeWorkspace.organization, activeWorkspace.workspace)
			: "/workspace"
		: "/sign-in";
	return { authLoaded, signOut, user, workspaceState, workspaceTo };
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
	const { signOut, user, workspaceTo } = useWorkspaceCta();
	return (
		<header
			className={cn(
				"z-20 flex items-center justify-between px-5 py-6 sm:px-14",
				sticky
					? "sticky top-0 border-b border-[#1c1917]/8 bg-[#fbf6f0]"
					: "relative",
			)}
		>
			<div className="flex items-center gap-[18px]">
				<Link
					className="inline-flex items-center gap-[9px] text-lg font-bold tracking-[-.01em] text-[#1c1917] no-underline"
					to="/"
					aria-label="LixRay home"
				>
					<img className="size-[26px]" src="/lixray-mark.svg" alt="" />
					<span>LixRay</span>
				</Link>
				<span className="h-[18px] w-px bg-[#1c1917]/15" aria-hidden="true" />
				<Link
					className="text-[15px] font-semibold text-[#57534e] no-underline hover:text-[#1c1917]"
					to="/docs"
				>
					Docs
				</Link>
			</div>
			<nav
				className="flex items-center gap-5 text-[15px] font-semibold sm:gap-6"
				aria-label="Primary navigation"
			>
				<a
					className="hidden text-[#57534e] no-underline sm:block"
					href="https://github.com/opral"
					target="_blank"
					rel="noreferrer"
				>
					GitHub ↗
				</a>
				{user ? (
					<button
						className="cursor-pointer border-0 bg-transparent p-0 text-[#1c1917] hover:text-[#e8590c]"
						type="button"
						onClick={() => void signOut()}
					>
						Log out
					</button>
				) : (
					<a className="text-[#1c1917] no-underline" href="/sign-in">
						Sign in
					</a>
				)}
				<a
					className="rounded-[10px] bg-[linear-gradient(180deg,#F97316_0%,#E8590C_100%)] px-[18px] py-2.5 font-bold text-white no-underline shadow-[0_6px_16px_rgba(232,89,12,.3),inset_0_1px_0_rgba(255,255,255,.25)] transition hover:brightness-105"
					href={workspaceTo}
				>
					{user ? "Open LixRay" : "Get started"}
				</a>
			</nav>
			{children}
		</header>
	);
}
