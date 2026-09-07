import { useRouterState } from "@tanstack/react-router";
import { RepositoryMcpGuidance } from "./repository-mcp-guidance";

// The namespace parent also disables SSR, so it must share this fallback.
export function RepositoryAccessPending() {
	const location = useRouterState({ select: (state) => state.location });
	if (!/^\/(?:@|%40)[^/]+\/[^/]+/i.test(location.pathname)) return null;
	return (
		<RepositoryAccessScreen
			pathname={location.pathname}
			searchStr={location.searchStr}
		/>
	);
}

export function RepositoryAccessScreen({
	pathname,
	searchStr,
	status = "pending",
	signedIn = false,
	onSignIn,
	onRetry,
}: {
	pathname: string;
	searchStr: string;
	status?: "pending" | "unavailable" | "error";
	signedIn?: boolean;
	onSignIn?: () => void;
	onRetry?: () => void;
}) {
	const isFile = /\/file\//.test(pathname);
	const resource = isFile ? "file" : "repository";
	const pending = status === "pending";
	const failed = status === "error";
	let path = pathname;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		// A malformed URL can still be displayed safely as text.
	}
	return (
		<div
			className="flex min-h-svh flex-col bg-bg-app text-text-primary"
			data-repository-access={status}
		>
			<header className="flex h-14 shrink-0 items-center border-b border-border-subtle px-6">
				<a href="/" className="inline-flex items-center gap-2 font-semibold">
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					LixRay
				</a>
			</header>
			<main className="mx-auto my-auto w-full max-w-[620px] px-6 py-16">
				<p className="mb-7 break-all font-mono text-xs leading-relaxed text-text-tertiary">
					{path}
				</p>
				<div aria-live="polite">
					<p className="mb-3 font-mono text-xs text-text-tertiary">
						{pending ? "LIXRAY" : failed ? "CONNECTION ERROR" : "404"}
					</p>
					<h1 className="mb-3 min-h-16 text-2xl font-semibold leading-tight sm:min-h-8">
						{pending
							? `Opening ${resource}...`
							: failed
								? `Unable to check ${resource} access`
								: `This ${resource} isn't available`}
					</h1>
					<p className="min-h-32 max-w-[460px] text-sm leading-relaxed text-text-tertiary sm:min-h-20">
						{pending
							? "Checking this link and your access."
							: failed
								? "We couldn't check this link. Please try again."
								: signedIn
									? "The link may be incorrect, or your account may not have access. Check with the person who shared it, or try another account."
									: "The link may be incorrect, or you may not have access. Sign in with an account that has access, or check with the person who shared it."}
					</p>
				</div>
				<div className="mb-8 mt-5 flex min-h-10 flex-wrap items-center gap-5">
					<button
						type="button"
						disabled={pending}
						onClick={failed ? onRetry : onSignIn}
						className="rounded-md border border-border-subtle bg-bg-panel px-4 py-2 text-sm font-semibold disabled:opacity-50"
					>
						{failed ? "Retry" : signedIn ? "Switch account" : "Sign in"}
					</button>
					<a href="/home" className="text-sm underline underline-offset-4">
						Go to repositories
					</a>
				</div>
				<details className="border-t border-border-subtle pt-5">
					<summary className="cursor-pointer text-sm font-semibold">
						For agents: use LixRay MCP
					</summary>
					<div className="pt-3">
						<RepositoryMcpGuidance
							pathname={pathname}
							searchStr={searchStr}
							visible
						/>
					</div>
				</details>
			</main>
		</div>
	);
}
