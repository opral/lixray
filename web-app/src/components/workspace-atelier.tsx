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
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Lix } from "@lix-js/sdk";
import { useAuth } from "~/components/auth-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { DEMO_AUTH_TOKEN } from "~/lib/demo-identity";
import { openMockRemoteLix } from "~/lib/mock-remote-lix";
import {
	isLixBranchNotFoundError,
	resolveAtelierRouteBranchId,
	shouldNormalizeInitialBranch,
} from "~/lib/atelier-navigation";
import {
	createWorkspaceBranchSession,
	createWorkspacePreferencesStore,
	createWorkspaceReviewStatusStore,
	createWorkspaceSessionStateStore,
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
	const routeParams = useParams({ strict: false });
	const routeFilePath =
		"_splat" in routeParams ? routeParams._splat : undefined;
	const [instance, setInstance] = useState<AtelierInstance | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeLixRef = useRef<BrowserLix | null>(null);
	const pathnameRef = useRef(pathname);
	const routeFilePathRef = useRef(routeFilePath);
	const branchIdRef = useRef(branchId);
	const routeBranchSwitchRef = useRef(0);
	const suppressBranchNavigationRef = useRef(false);
	const eventHandlerRef = useRef<(event: AtelierEvent) => void>(
		() => undefined,
	);
	useEffect(() => {
		pathnameRef.current = pathname;
	}, [pathname]);
	useEffect(() => {
		routeFilePathRef.current = routeFilePath;
	}, [routeFilePath]);
	useLayoutEffect(() => {
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
			const filePath = routeFilePathRef.current;
			if (filePath !== undefined) {
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
			if (routeFilePathRef.current === filePath) return;
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

		const userId = isDemoModeEnabled ? DEMO_AUTH_TOKEN : user?.id;
		if (!userId) {
			setError("Unable to identify the current Atelier account.");
			return;
		}
		const openingBranchId = branchIdRef.current ?? null;
		void openMockRemoteLix({
			workspaceId,
			getAccessToken,
			initialBranchId: openingBranchId,
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
					onSwitch: async (nextBranchId, context) => {
						const routedBranchId = resolveAtelierRouteBranchId(
							branchIdRef.current,
							lix.mainBranchSnapshot(),
						);
						if (
							suppressBranchNavigationRef.current ||
							routedBranchId === nextBranchId ||
							(context?.failedBranchId !== undefined &&
								routedBranchId === context.failedBranchId)
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
						reviewRangeSessionId: userId,
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
				if (
					shouldNormalizeInitialBranch({
						openingBranchId,
						currentBranchId: branchIdRef.current ?? null,
						actualBranchId,
					})
				) {
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
		if (!instance || !lix) return;
		const requestedBranchId = resolveAtelierRouteBranchId(
			branchId,
			lix.mainBranchSnapshot(),
		);
		const routeSwitch = ++routeBranchSwitchRef.current;
		void (async () => {
			try {
				await instance.branches.switch(requestedBranchId);
			} catch (caught) {
				if (routeSwitch !== routeBranchSwitchRef.current) return;
				if (!isLixBranchNotFoundError(caught)) {
					console.error(
						"Unable to switch to the requested Atelier branch",
						caught,
					);
					return;
				}
				const mainBranchId = lix.mainBranchSnapshot();
				try {
					if (instance.branches.activeId() !== mainBranchId) {
						suppressBranchNavigationRef.current = true;
						try {
							await instance.branches.switch(mainBranchId);
						} finally {
							suppressBranchNavigationRef.current = false;
						}
					}
					if (routeSwitch !== routeBranchSwitchRef.current) return;
					await navigateToCurrentPathBranch(mainBranchId, true);
				} catch (fallbackError) {
					if (routeSwitch === routeBranchSwitchRef.current) {
						console.error(
							"Unable to recover from a missing Atelier branch",
							fallbackError,
						);
					}
				}
			}
		})();
		return () => {
			if (routeSwitch === routeBranchSwitchRef.current) {
				routeBranchSwitchRef.current += 1;
			}
		};
	}, [branchId, instance, navigateToCurrentPathBranch, pathname]);

	useEffect(() => {
		if (!instance) return;
		const workspaceRoot = `/@${namespace}/${workspaceSlug}`;
		if (pathname !== workspaceRoot) return;
		void instance.documents.closeAll();
	}, [instance, namespace, pathname, workspaceSlug]);

	return (
		<div
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg-app"
			aria-busy={!instance && !error}
		>
			{instance ? (
				<WorkspaceAtelierContext.Provider value={instance}>
					<Atelier
						instance={instance}
						topBarProps={{
							"data-app-titlebar": true,
							className: "border-b border-border-subtle bg-bg-app",
						}}
						slots={{
							navbarStart: (
								<Link
									to="/"
									aria-label="Back to LixRay home"
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
				<main className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-bg-app p-6 text-center text-text-secondary">
					Opening workspace…
				</main>
			) : null}
			{error ? (
				<main className="absolute inset-0 grid place-content-center bg-bg-app p-6 text-center text-text-secondary">
					<div
						className="grid justify-items-center gap-2 [&_span]:max-w-[640px] [&_span]:text-text-tertiary"
						role="alert"
					>
						<strong>Unable to open Atelier</strong>
						<span>{error}</span>
					</div>
				</main>
			) : null}
		</div>
	);
}

export function useWorkspaceAtelierInstance(): AtelierInstance | null {
	return useContext(WorkspaceAtelierContext);
}
