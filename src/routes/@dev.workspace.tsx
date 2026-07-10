import type { Lix } from "@lix-js/sdk";
import { Atelier } from "@opral/atelier";
import "@opral/atelier/style.css";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { seedAtelierWorkspace } from "~/lib/seed-atelier-workspace";

export const Route = createFileRoute("/@dev/workspace")({
	ssr: false,
	head: () => ({
		meta: [{ title: "Dev workspace · Lixray" }],
	}),
	component: DevWorkspacePage,
});

function DevWorkspacePage() {
	const [lix, setLix] = useState<Lix | null>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "error">(
		"loading",
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		let activeLix: Lix | null = null;

		const start = async () => {
			try {
				const { openLix } = await import("@lix-js/sdk");
				const openedLix = await openLix();

				if (disposed) {
					await openedLix.close();
					return;
				}

				activeLix = openedLix;
				await seedAtelierWorkspace(openedLix);
				if (disposed) return;

				setLix(openedLix);
				setStatus("ready");
			} catch (caught) {
				const lixToClose = activeLix;
				activeLix = null;
				if (lixToClose) await lixToClose.close();
				if (disposed) return;
				setError(caught instanceof Error ? caught.message : String(caught));
				setStatus("error");
			}
		};

		void start();

		return () => {
			disposed = true;
			const lixToClose = activeLix;
			activeLix = null;
			if (lixToClose) void lixToClose.close();
		};
	}, []);

	return (
		<main className="atelier-route" aria-busy={status === "loading"}>
			{lix ? (
				<Atelier
					lix={lix}
					slots={{
						navbarStart: (
							<Link
								to="/"
								aria-label="Back to Lixray home"
								className="flex size-7 items-center justify-start rounded-[7px] text-[var(--color-icon-brand)] transition-colors hover:bg-[var(--color-bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-ring-focus-visible)]"
								data-attr="lixray-workspace-home"
							>
								<LixrayMark />
							</Link>
						),
					}}
				/>
			) : null}
			{status === "loading" ? (
				<div className="atelier-route-status">Opening workspace…</div>
			) : null}
			{status === "error" ? (
				<div className="atelier-route-status" role="alert">
					<strong>Unable to open Atelier</strong>
					<span>{error}</span>
				</div>
			) : null}
		</main>
	);
}

function LixrayMark() {
	return (
		<svg
			aria-hidden="true"
			className="size-[18px]"
			focusable="false"
			viewBox="0 0 100 100"
		>
			<path
				fill="currentColor"
				fillRule="evenodd"
				d="M34 8 H66 A26 26 0 0 1 92 34 V66 A26 26 0 0 1 66 92 H34 A26 26 0 0 1 8 66 V34 A26 26 0 0 1 34 8 Z M32.6 23.4 L76.6 67.4 L67.4 76.6 L23.4 32.6 Z M76.6 32.6 L32.6 76.6 L23.4 67.4 L67.4 23.4 Z"
			/>
		</svg>
	);
}
