import { createFileRoute } from "@tanstack/react-router";
import type { Lix } from "@lix-js/sdk";
import "@opral/atelier/style.css";
import { useEffect, useRef, useState } from "react";
import { seedAtelierWorkspace } from "~/lib/seed-atelier-workspace";

export const Route = createFileRoute("/@dev/workspace")({
	head: () => ({
		meta: [{ title: "Dev workspace · Lixray" }],
	}),
	component: DevWorkspacePage,
});

function DevWorkspacePage() {
	const mountRef = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "error">(
		"loading",
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		let lix: Lix | null = null;

		const start = async () => {
			try {
				const [{ openLix }, { createAtelier }] = await Promise.all([
					import("@lix-js/sdk"),
					import("@opral/atelier"),
				]);
				lix = await openLix();
				await seedAtelierWorkspace(lix);

				if (disposed) {
					await lix.close();
					return;
				}

				const element = mountRef.current;
				if (!element) throw new Error("Atelier mount element is unavailable");

				createAtelier({ element, lix });
				setStatus("ready");
			} catch (caught) {
				if (disposed) return;
				setError(caught instanceof Error ? caught.message : String(caught));
				setStatus("error");
			}
		};

		void start();

		return () => {
			disposed = true;
			if (lix) void lix.close();
		};
	}, []);

	return (
		<main className="atelier-route" aria-busy={status === "loading"}>
			<div ref={mountRef} className="atelier-mount" />
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
