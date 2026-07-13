import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";

export function PreviewUnavailable({ feature }: { feature: string }) {
	return (
		<main className="grid min-h-dvh place-items-center bg-bg-app p-6 text-text-primary">
			<section className="grid w-[min(560px,100%)] gap-3 rounded-xl border border-border-panel bg-bg-panel p-7 text-center shadow-md">
				<p className="m-0 text-[12px] font-bold tracking-[0.08em] text-text-link uppercase">
					PR frontend preview
				</p>
				<h1 className="m-0 text-2xl">{feature} is unavailable</h1>
				<p className="m-0 text-sm leading-relaxed text-text-tertiary">
					This preview intentionally excludes authentication, workspace storage,
					MCP, and other backend services.
				</p>
				<Button className="mt-2 justify-self-center" asChild variant="outline">
					<Link to="/">Back to frontend preview</Link>
				</Button>
			</section>
		</main>
	);
}
