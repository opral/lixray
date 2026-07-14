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
import { isDemoModeEnabled } from "~/lib/demo-client";
import { DEMO_AUTH_TOKEN } from "~/lib/demo-identity";
import { openMockRemoteLix } from "~/lib/mock-remote-lix";
import {
	createWorkspaceBranchSession,
	createWorkspacePreferencesStore,
	createWorkspaceReviewStatusStore,
	createWorkspaceSessionStateStore,
	readWorkspaceSessionBranch,
} from "~/lib/atelier-state";
import type { BrowserLix } from "~/lib/mock-remote-lix";

interface WorkspaceAtelierProps {
	workspaceId: string;
	namespace: string;
	workspaceSlug: string;
	branchId?: string;
}

const WorkspaceAtelierContext = createContext<AtelierInstance | null>(null);

export function WorkspaceAtelier({
	workspaceId,
	namespace,
	workspaceSlug,
	branchId,
}: WorkspaceAtelierProps) {
	const { client, getAccessToken: getSessionAccessToken, user } = useAuth();
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const [instance, setInstance] = useState<AtelierInstance | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeLixRef = useRef<BrowserLix | null>(null);
	const pathnameRef = useRef(pathname);
	const branchIdRef = useRef(branchId);
	const suppressBranchNavigationRef = useRef(false);
	const eventHandlerRef = useRef<(event: AtelierEvent) => void>(
		() => undefined,
	);
	useEffect(() => {
		pathnameRef.current = pathname;
	}, [pathname]);
	useEffect(() => {
		branchIdRef.current = branchId;
	}, [branchId]);
	const getAccessToken = useCallback(
		() =>
			isDemoModeEnabled
				? Promise.resolve(DEMO_AUTH_TOKEN)
				: getSessionAccessToken(),
		[getSessionAccessToken],
	);
	const navigateToCurrentPathBranch = useCallback(
		async (nextBranchId: string, replace = false) => {
			const filePrefix = `/@${namespace}/${workspaceSlug}/file/`;
			if (pathnameRef.current.startsWith(filePrefix)) {
				const filePath = pathnameRef.current.slice(filePrefix.length);
				await navigate({
					to: "/@{$namespace}/$workspace/file/$",
					params: {
						namespace,
						workspace: workspaceSlug,
						_splat: filePath,
					},
					search: { branch: nextBranchId },
					replace,
				});
				return;
			}
			await navigate({
				to: "/@{$namespace}/$workspace",
				params: { namespace, workspace: workspaceSlug },
				search: { branch: nextBranchId },
				replace,
			});
		},
		[namespace, navigate, workspaceSlug],
	);

	useEffect(() => {
		eventHandlerRef.current = (event) => {
			const nextFilePath =
				event.type === "document_viewed"
					? event.filePath
					: event.type === "document_closed"
						? event.nextFilePath
						: undefined;
			if (nextFilePath === undefined) return;
			const filePath = nextFilePath?.replace(/^\/+/, "") ?? "";
			const activeBranchId = activeLixRef.current?.activeBranchSnapshot();
			if (!filePath) {
				const targetPath = `/@${namespace}/${workspaceSlug}`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$workspace",
					params: { namespace, workspace: workspaceSlug },
					search: activeBranchId ? { branch: activeBranchId } : {},
				});
				return;
			}
			const targetPath = `/@${namespace}/${workspaceSlug}/file/${filePath}`;
			if (pathnameRef.current === targetPath) return;
			void navigate({
				to: "/@{$namespace}/$workspace/file/$",
				params: {
					namespace,
					workspace: workspaceSlug,
					_splat: filePath,
				},
				search: activeBranchId ? { branch: activeBranchId } : {},
			});
		};
	}, [namespace, navigate, workspaceSlug]);

	useEffect(() => {
		let disposed = false;
		let activeLix: Lix | null = null;
		setInstance(null);
		setError(null);

		const userId = user?.id ?? "demo";
		const initialBranchId =
			branchIdRef.current ??
			readWorkspaceSessionBranch({ userId, workspaceId });
		void openMockRemoteLix({
			workspaceId,
			getAccessToken,
			initialBranchId,
		})
			.then(async (lix) => {
				if (disposed) {
					await lix.close();
					return;
				}
				activeLix = lix;
				activeLixRef.current = lix;
				const branchSession = createWorkspaceBranchSession({
					lix,
					userId,
					workspaceId,
					onSwitch: async (nextBranchId) => {
						if (
							suppressBranchNavigationRef.current ||
							branchIdRef.current === nextBranchId
						) {
							return;
						}
						await navigateToCurrentPathBranch(nextBranchId);
					},
				});
				setInstance(
					createAtelier({
						lix,
						branchSession,
						sessionStateStore: createWorkspaceSessionStateStore({
							userId,
							workspaceId,
						}),
						preferencesStore: createWorkspacePreferencesStore({
							client,
							userId,
							workspaceId,
						}),
						reviewStatusStore: createWorkspaceReviewStatusStore({
							client,
							userId,
							workspaceId,
						}),
						onEvent: (event) => eventHandlerRef.current(event),
					}),
				);
				const actualBranchId = lix.activeBranchSnapshot();
				if (branchIdRef.current !== actualBranchId) {
					await navigateToCurrentPathBranch(actualBranchId, true);
				}
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
			activeLixRef.current = null;
			if (lix) void lix.close();
		};
	}, [
		client,
		getAccessToken,
		navigateToCurrentPathBranch,
		user?.id,
		workspaceId,
	]);

	useEffect(() => {
		const lix = activeLixRef.current;
		if (!instance || !lix || !branchId) return;
		if (instance.branches.activeId() === branchId) return;
		void instance.branches.switch(branchId).catch(async () => {
			const mainBranchId = lix.mainBranchSnapshot();
			if (instance.branches.activeId() !== mainBranchId) {
				suppressBranchNavigationRef.current = true;
				try {
					await instance.branches.switch(mainBranchId);
				} finally {
					suppressBranchNavigationRef.current = false;
				}
			}
			await navigateToCurrentPathBranch(mainBranchId, true);
		});
	}, [branchId, instance, navigateToCurrentPathBranch]);

	useEffect(() => {
		if (!instance) return;
		const workspaceRoot = `/@${namespace}/${workspaceSlug}`;
		if (pathname !== workspaceRoot) return;
		void instance.documents.closeAll();
	}, [instance, namespace, pathname, workspaceSlug]);

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
