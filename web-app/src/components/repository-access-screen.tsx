import { useRouterState } from "@tanstack/react-router";
import { WorkspaceTitlebarStrip } from "./workspace-titlebar-strip";
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
	const failed = status === "error";
	let path = pathname;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		// A malformed URL can still be displayed safely as text.
	}
	const title = path.split("/").slice(1, 3).join(" / ");
	if (status === "pending") {
		// Only the URL and decorative placeholders are available before access resolves.
		// Keep this independent of Atelier and any repository data or auth controls.
		return (
			<div
				className="flex h-svh flex-col overflow-hidden bg-bg text-fg"
				data-repository-access="pending"
			>
				<WorkspaceTitlebarStrip />
				{/* The workspace's own frame — sidebar column, then the white
				    island with its 40px header — so nothing moves when it loads.
				    The sidebar opens from 768px, as the workspace opens it. */}
				<div className="flex min-h-0 flex-1 px-2 pt-2 pb-2">
					<div
						data-repository-access-sidebar
						className="mr-1 hidden w-[20%] min-w-0 shrink-0 flex-col md:flex"
					>
						<div className="flex h-10 min-w-0 items-center gap-2 px-1.5">
							<PendingBrand title={title} />
						</div>
						<div aria-hidden="true" className="mt-3 flex flex-col gap-3 px-1.5">
							{["w-16", "w-24", "w-20", "w-24", "w-16"].map((width, index) => (
								<div key={index} className="flex h-4 items-center gap-2">
									<div className="size-3.5 shrink-0 rounded bg-fg-faint/20" />
									<div className={`h-2 rounded bg-fg-faint/20 ${width}`} />
								</div>
							))}
						</div>
					</div>
					<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-panel">
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-1.5">
							<div className="flex min-w-0 items-center gap-2 md:hidden">
								<PendingBrand title={title} />
							</div>
							<div
								aria-hidden="true"
								className="ml-1 h-2 w-20 rounded bg-fg-faint/20"
							/>
						</div>
						<div className="mx-auto w-full max-w-5xl overflow-hidden px-6 py-10 sm:px-12 sm:py-14">
							<div
								role="status"
								className="flex items-center gap-3 text-fg-subtle"
							>
								<svg
									aria-hidden="true"
									viewBox="0 0 24 24"
									fill="none"
									className="size-4 shrink-0 motion-safe:animate-spin"
								>
									<circle
										cx="12"
										cy="12"
										r="9"
										stroke="currentColor"
										strokeWidth="2"
										opacity="0.2"
									/>
									<path
										d="M12 3a9 9 0 0 1 9 9"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
									/>
								</svg>
								<h1 className="text-sm font-medium">Opening {resource}...</h1>
							</div>
							<div
								aria-hidden="true"
								data-repository-access-skeleton
								className="mt-9 space-y-6 motion-safe:animate-pulse"
							>
								{["w-2/5", "w-1/3", "w-3/5", "w-1/2", "w-2/5"].map(
									(width, index) => (
										<div key={index} className="flex h-8 items-center gap-4">
											<div className="size-5 shrink-0 rounded bg-fg-faint/20" />
											<div className={`h-2 rounded bg-fg-faint/20 ${width}`} />
											<div className="ml-auto hidden h-2 w-12 rounded bg-fg-faint/15 sm:block" />
										</div>
									),
								)}
							</div>
						</div>
					</main>
				</div>
			</div>
		);
	}
	return (
		<div
			className="flex min-h-svh flex-col bg-bg text-fg"
			data-repository-access={status}
		>
			<header className="flex h-14 shrink-0 items-center border-b border-border-subtle px-6">
				<a href="/" className="inline-flex items-center gap-2 font-semibold">
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					LixRay
				</a>
			</header>
			<main className="mx-auto my-auto w-full max-w-[620px] px-6 py-16">
				<p className="mb-7 break-all font-mono text-xs leading-relaxed text-fg-subtle">
					{path}
				</p>
				<div aria-live="polite">
					<p className="mb-3 font-mono text-xs text-fg-subtle">
						{failed ? "CONNECTION ERROR" : "404"}
					</p>
					<h1 className="mb-3 min-h-16 text-2xl font-semibold leading-tight sm:min-h-8">
						{failed
							? `Unable to check ${resource} access`
							: `This ${resource} isn't available`}
					</h1>
					<p className="min-h-32 max-w-[460px] text-sm leading-relaxed text-fg-subtle sm:min-h-20">
						{failed
							? "We couldn't check this link. Please try again."
							: signedIn
								? "The link may be incorrect, or your account may not have access. Check with the person who shared it, or try another account."
								: "The link may be incorrect, or you may not have access. Sign in with an account that has access, or check with the person who shared it."}
					</p>
				</div>
				<div className="mb-8 mt-5 flex min-h-10 flex-wrap items-center gap-5">
					<button
						type="button"
						onClick={failed ? onRetry : onSignIn}
						className="rounded-md border border-border-subtle bg-panel px-4 py-2 text-sm font-semibold disabled:opacity-50"
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

/** The workspace brand's place and size, as text: nothing to press yet. */
function PendingBrand({ title }: { title: string }) {
	return (
		<>
			<a
				href="/"
				aria-label="LixRay home"
				className="inline-flex shrink-0 items-center rounded-[5px]"
			>
				<img className="size-6" src="/lixray-mark.svg" alt="" />
			</a>
			<span className="min-w-0 truncate text-[13px] font-semibold text-fg">
				{title}
			</span>
		</>
	);
}
