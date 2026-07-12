import {
	Atelier,
	createAtelier,
	type AtelierEvent,
	type AtelierInstance,
} from "@opral/atelier";
import "@opral/atelier/style.css";
import {
	Link,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { Lix } from "@lix-js/sdk";
import { useAuth } from "~/components/auth-provider";
import { E2E_AUTH_TOKEN } from "~/lib/e2e-auth";
import { isE2eAuthEnabled } from "~/lib/e2e-client";
import { openMockRemoteLix } from "~/lib/mock-remote-lix";

interface WorkspaceAtelierProps {
	workspaceId: string;
	namespace: string;
	workspaceSlug: string;
}

const WorkspaceAtelierContext = createContext<AtelierInstance | null>(null);

export function WorkspaceAtelier({
	workspaceId,
	namespace,
	workspaceSlug,
}: WorkspaceAtelierProps) {
	const { getAccessToken: getSessionAccessToken } = useAuth();
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const [instance, setInstance] = useState<AtelierInstance | null>(null);
	const [error, setError] = useState<string | null>(null);
	const eventHandlerRef = useRef<(event: AtelierEvent) => void>(
		() => undefined,
	);
	const getAccessToken = useCallback(
		() =>
			isE2eAuthEnabled
				? Promise.resolve(E2E_AUTH_TOKEN)
				: getSessionAccessToken(),
		[getSessionAccessToken],
	);

	useEffect(() => {
		eventHandlerRef.current = (event) => {
			if (event.type !== "document_viewed") return;
			const filePath = event.filePath.replace(/^\/+/, "");
			if (!filePath) return;
			const targetPath = `/@${namespace}/${workspaceSlug}/file/${filePath}`;
			if (pathname === targetPath) return;
			void navigate({
				to: "/@{$namespace}/$workspace/file/$",
				params: {
					namespace,
					workspace: workspaceSlug,
					_splat: filePath,
				},
			});
		};
	}, [namespace, navigate, pathname, workspaceSlug]);

	useEffect(() => {
		let disposed = false;
		let activeLix: Lix | null = null;
		setInstance(null);
		setError(null);

		void openMockRemoteLix({ workspaceId, getAccessToken })
			.then(async (lix) => {
				if (disposed) {
					await lix.close();
					return;
				}
				activeLix = lix;
				setInstance(
					createAtelier({
						lix,
						onEvent: (event) => eventHandlerRef.current(event),
					}),
				);
			})
			.catch((caught: unknown) => {
				if (!disposed) {
					setError(caught instanceof Error ? caught.message : String(caught));
				}
			});

		return () => {
			disposed = true;
			const lix = activeLix;
			activeLix = null;
			if (lix) void lix.close();
		};
	}, [getAccessToken, workspaceId]);

	return (
		<main
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg-app"
			aria-busy={!instance && !error}
		>
			{instance ? (
				<WorkspaceAtelierContext.Provider value={instance}>
					<Atelier
						instance={instance}
						slots={{
							navbarStart: (
								<Link
									to="/"
									aria-label="Back to Lixray home"
									className="flex size-7 items-center justify-start rounded-[7px] transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible"
								>
									<img src="/lixray-mark.svg" alt="" className="size-[18px]" />
								</Link>
							),
						}}
					/>
					<Outlet />
				</WorkspaceAtelierContext.Provider>
			) : null}
			{!instance && !error ? (
				<div className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-bg-app p-6 text-center text-text-secondary">
					Opening workspace…
				</div>
			) : null}
			{error ? (
				<div
					className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-bg-app p-6 text-center text-text-secondary [&_span]:max-w-[640px] [&_span]:text-text-tertiary"
					role="alert"
				>
					<strong>Unable to open Atelier</strong>
					<span>{error}</span>
				</div>
			) : null}
		</main>
	);
}

export function useWorkspaceAtelierInstance(): AtelierInstance | null {
	return useContext(WorkspaceAtelierContext);
}
