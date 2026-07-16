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
import { createAtelierTelemetryHandler } from "~/lib/atelier-telemetry";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { DEMO_AUTH_TOKEN } from "~/lib/demo-identity";
import { openMockRemoteLix } from "~/lib/mock-remote-lix";
import {
	atelierBranchSearch,
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
import { captureTelemetry } from "~/lib/telemetry";

interface WorkspaceAtelierProps {
	workspaceId: string;
	namespace: string;
	workspaceSlug: string;
	branchId?: string;
}

const WorkspaceAtelierContext = createContext<AtelierInstance | null>(null);
const WorkspaceDefaultBranchContext = createContext<string | null>(null);

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
	const [workspaceDefaultBranchId, setWorkspaceDefaultBranchId] = useState<
		string | null
	>(null);
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
	const atelierTelemetryHandlerRef = useRef<
		ReturnType<typeof createAtelierTelemetryHandler> | undefined
	>(undefined);
	atelierTelemetryHandlerRef.current ??=
		createAtelierTelemetryHandler(captureTelemetry);
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
			const defaultBranchId = activeLixRef.current?.defaultBranchSnapshot();
			const search = defaultBranchId
				? atelierBranchSearch(nextBranchId, defaultBranchId)
				: { branch: nextBranchId };
			const filePath = routeFilePathRef.current;
			if (filePath !== undefined) {
				await navigate({
					to: "/@{$namespace}/$workspace/file/$",
					params: {
						namespace,
						workspace: workspaceSlug,
						_splat: filePath,
					},
					search,
					replace,
				});
				return;
			}
			await navigate({
				to: "/@{$namespace}/$workspace",
				params: { namespace, workspace: workspaceSlug },
				search,
				replace,
			});
		},
		[namespace, navigate, workspaceSlug],
	);

	useEffect(() => {
		eventHandlerRef.current = (event) => {
			atelierTelemetryHandlerRef.current?.(event);
			const nextFilePath =
				event.type === "document_viewed"
					? event.filePath
					: event.type === "document_closed"
						? event.nextFilePath
						: undefined;
			if (nextFilePath === undefined) return;
			const filePath = nextFilePath?.replace(/^\/+/, "") ?? "";
			const activeBranchId = activeLixRef.current?.activeBranchSnapshot();
			const defaultBranchId = activeLixRef.current?.defaultBranchSnapshot();
			const search =
				activeBranchId && defaultBranchId
					? atelierBranchSearch(activeBranchId, defaultBranchId)
					: {};
			if (!filePath) {
				const targetPath = `/@${namespace}/${workspaceSlug}`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$workspace",
					params: { namespace, workspace: workspaceSlug },
					search,
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
				search,
			});
		};
	}, [namespace, navigate, workspaceSlug]);

	useEffect(() => {
		let disposed = false;
		let activeLix: Lix | null = null;
		setInstance(null);
		setWorkspaceDefaultBranchId(null);
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
				setWorkspaceDefaultBranchId(lix.defaultBranchSnapshot());
				const branchSession = createWorkspaceBranchSession({
					lix,
					onSwitch: async (nextBranchId, context) => {
						const routedBranchId = resolveAtelierRouteBranchId(
							branchIdRef.current,
							lix.defaultBranchSnapshot(),
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
				captureTelemetry("workspace_opened");
				const actualBranchId = lix.activeBranchSnapshot();
				if (
					shouldNormalizeInitialBranch({
						openingBranchId,
						currentBranchId: branchIdRef.current ?? null,
						actualBranchId,
						defaultBranchId: lix.defaultBranchSnapshot(),
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
			lix.defaultBranchSnapshot(),
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
				const defaultBranchId = lix.defaultBranchSnapshot();
				try {
					if (instance.branches.activeId() !== defaultBranchId) {
						suppressBranchNavigationRef.current = true;
						try {
							await instance.branches.switch(defaultBranchId);
						} finally {
							suppressBranchNavigationRef.current = false;
						}
					}
					if (routeSwitch !== routeBranchSwitchRef.current) return;
					await navigateToCurrentPathBranch(defaultBranchId, true);
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
				<WorkspaceDefaultBranchContext.Provider
					value={workspaceDefaultBranchId}
				>
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
										to="/home"
										aria-label="Back to workspaces"
										className="flex size-7 items-center justify-start rounded-[7px] transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring-focus-visible"
									>
										<img
											src="/lixray-mark.svg"
											alt=""
											className="size-[18px]"
										/>
									</Link>
								),
							}}
						/>
						<Outlet />
					</WorkspaceAtelierContext.Provider>
				</WorkspaceDefaultBranchContext.Provider>
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

export function useWorkspaceDefaultBranchId(): string | null {
	return useContext(WorkspaceDefaultBranchContext);
}
