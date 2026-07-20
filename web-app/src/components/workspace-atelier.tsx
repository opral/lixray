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
	useSyncExternalStore,
} from "react";
import { PencilLine, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { WorkspaceShareDialog } from "~/components/workspace-share-dialog";
import { Button } from "~/components/ui/button";
import { createAtelierTelemetryHandler } from "~/lib/atelier-telemetry";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { DEMO_AUTH_TOKEN } from "~/lib/demo-identity";
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
	type WorkspaceBranchSession,
} from "~/lib/atelier-state";
import { captureTelemetry } from "~/lib/telemetry";
import {
	appendWorkspaceShareToken,
	canonicalPathFromLocation,
	stripInviteFromUrl,
} from "~/lib/workspace-share-url";
import { isWorkspaceShareToken } from "~/lib/workspace-share-capability";
import {
	openWorkspaceLixSession,
	type WorkspaceLixSession,
} from "~/lib/workspace-lix-session";
import {
	LIXRAY_DIR_EXTENSION_ID,
	LIXRAY_HOME_EXTENSION_ID,
	lixrayDirInstanceId,
	lixrayDirViewState,
	lixrayWorkspaceExtensions,
} from "~/components/workspace-home/host-extensions";
import { LixrayCentralTabStrip } from "~/components/workspace-home/central-tab-strip";
import {
	normalizeHomeDirPath,
	useWorkspaceIsEmpty,
} from "~/components/workspace-home/lix-data";

interface WorkspaceAtelierProps {
	workspaceId: string;
	namespace: string;
	workspaceSlug: string;
	workspaceName: string;
	branchId?: string;
	/** The only mode allowed to make workspace mutations in this view. */
	canEdit: boolean;
	/** Present only for a valid, session-held share capability. */
	shareAccess?: {
		onJoinToEdit: () => Promise<void>;
		joining: boolean;
	};
}

const WorkspaceAtelierContext = createContext<AtelierInstance | null>(null);
const WorkspaceDefaultBranchContext = createContext<string | null>(null);
const WorkspaceRouteSyncContext = createContext<(() => void) | null>(null);
const WorkspaceBranchSessionContext =
	createContext<WorkspaceBranchSession | null>(null);

export function WorkspaceAtelier({
	workspaceId,
	namespace,
	workspaceSlug,
	workspaceName,
	branchId,
	canEdit,
	shareAccess,
}: WorkspaceAtelierProps) {
	const {
		client,
		getAccessToken: getSessionAccessToken,
		isLoaded: isAuthLoaded,
		signInWithGoogle,
		user,
	} = useAuth();
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const routeParams = useParams({ strict: false });
	const routeSplat = "_splat" in routeParams ? routeParams._splat : undefined;
	const workspaceRootPath = `/@${namespace}/${workspaceSlug}`;
	const routeChildKind: "file" | "dir" | null = pathname.startsWith(
		`${workspaceRootPath}/file/`,
	)
		? "file"
		: pathname.startsWith(`${workspaceRootPath}/dir/`)
			? "dir"
			: null;
	const routeFilePath = routeChildKind === "file" ? routeSplat : undefined;
	const documentName = activeDocumentName({
		pathname,
		routeFilePath,
		workspaceName,
	});
	const isReadOnly = !canEdit;
	const [instance, setInstance] = useState<AtelierInstance | null>(null);
	const [branchSession, setBranchSession] =
		useState<WorkspaceBranchSession | null>(null);
	const [workspaceDefaultBranchId, setWorkspaceDefaultBranchId] = useState<
		string | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const activeLixRef = useRef<WorkspaceLixSession | null>(null);
	const pathnameRef = useRef(pathname);
	const routeChildRef = useRef<{
		kind: "file" | "dir" | null;
		splat: string | undefined;
	}>({ kind: routeChildKind, splat: routeSplat });
	const routeFilePathRef = useRef(routeFilePath);
	const branchIdRef = useRef(branchId);
	const routeBranchSwitchRef = useRef(0);
	const newTabSeqRef = useRef(0);
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
	useEffect(() => {
		routeChildRef.current = { kind: routeChildKind, splat: routeSplat };
	}, [routeChildKind, routeSplat]);
	useLayoutEffect(() => {
		branchIdRef.current = branchId;
	}, [branchId]);
	const getAccessToken = useCallback(
		() =>
			isDemoModeEnabled
				? Promise.resolve(canEdit ? DEMO_AUTH_TOKEN : null)
				: getSessionAccessToken(),
		[canEdit, getSessionAccessToken],
	);
	const signInToCurrentWorkspace = useCallback(async () => {
		try {
			await signInWithGoogle(canonicalPathFromLocation(window.location));
		} catch (caught) {
			toast.error(
				caught instanceof Error ? caught.message : "Unable to start sign-in.",
			);
		}
	}, [signInWithGoogle]);
	const workspaceIsEmpty = useWorkspaceIsEmpty(instance?.lix ?? null);
	const disabledShareButton = (
		<span
			aria-disabled="true"
			title="Nothing to share yet"
			className="inline-flex h-7 cursor-default items-center rounded-[7px] border border-border-panel px-3 text-xs font-semibold text-text-tertiary/70"
		>
			Share
		</span>
	);
	// Share stays inert until the workspace has content to share (12b/12c).
	const headerActions = canEdit ? (
		client && workspaceIsEmpty === false ? (
			<WorkspaceShareControl
				createShareToken={async () => {
					const { data, error } = await client.rpc(
						"create_workspace_share_token",
						{ p_workspace_id: workspaceId },
					);
					if (error) throw error;
					const token = data?.[0]?.token;
					if (!isWorkspaceShareToken(token)) {
						throw new Error("The share service returned an invalid link.");
					}
					return token;
				}}
				workspaceName={workspaceName}
				documentName={documentName}
			/>
		) : (
			disabledShareButton
		)
	) : (
		<div className="flex items-center gap-2">
			{!user ? (
				<Button
					type="button"
					variant="outline"
					size="xs"
					className="h-7 gap-1.5 px-3"
					disabled={!isAuthLoaded}
					onClick={() => void signInToCurrentWorkspace()}
				>
					Sign in
				</Button>
			) : null}
			{shareAccess ? (
				<Button
					type="button"
					variant="featured"
					size="xs"
					className="h-7 gap-1.5 px-3 font-semibold"
					disabled={shareAccess.joining}
					onClick={() =>
						void shareAccess.onJoinToEdit().catch((caught: unknown) => {
							toast.error(
								caught instanceof Error
									? caught.message
									: "Unable to join this workspace.",
							);
						})
					}
				>
					<PencilLine aria-hidden="true" />
					{shareAccess.joining ? "Joining…" : "Join to edit"}
				</Button>
			) : null}
		</div>
	);
	const navigateToCurrentPathBranch = useCallback(
		async (nextBranchId: string, replace = false) => {
			const defaultBranchId = activeLixRef.current?.defaultBranchSnapshot();
			const search = defaultBranchId
				? atelierBranchSearch(nextBranchId, defaultBranchId)
				: { branch: nextBranchId };
			const routeChild = routeChildRef.current;
			if (routeChild.kind && routeChild.splat !== undefined) {
				await navigate({
					to:
						routeChild.kind === "dir"
							? "/@{$namespace}/$workspace/dir/$"
							: "/@{$namespace}/$workspace/file/$",
					params: {
						namespace,
						workspace: workspaceSlug,
						_splat: routeChild.splat,
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

	// URL ⇄ tabs: the URL always names the ACTIVE central view. Atelier
	// reports activations (open, tab click, close, restore); the routes below
	// drive the reverse direction. Suppressed until the initial route has been
	// applied so a restored session cannot clobber a deep link.
	const routeSyncedRef = useRef(false);
	const markRouteSynced = useCallback(() => {
		routeSyncedRef.current = true;
	}, []);
	useEffect(() => {
		eventHandlerRef.current = (event) => {
			atelierTelemetryHandlerRef.current?.(event);
			if (event.type !== "central_view_activated") return;
			if (!routeSyncedRef.current) return;
			const activeBranchId = activeLixRef.current?.activeBranchSnapshot();
			const defaultBranchId = activeLixRef.current?.defaultBranchSnapshot();
			const search =
				activeBranchId && defaultBranchId
					? atelierBranchSearch(activeBranchId, defaultBranchId)
					: {};
			if (event.viewKind === LIXRAY_HOME_EXTENSION_ID) {
				const targetPath = `/@${namespace}/${workspaceSlug}`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$workspace",
					params: { namespace, workspace: workspaceSlug },
					search,
				});
				return;
			}
			if (event.viewKind === LIXRAY_DIR_EXTENSION_ID) {
				const dirPath = normalizeHomeDirPath(event.state?.path);
				const splat = dirPath.split("/").filter(Boolean).join("/");
				if (!splat) return;
				const targetPath = `/@${namespace}/${workspaceSlug}/dir/${splat}`;
				const currentPath = (() => {
					try {
						return decodeURIComponent(pathnameRef.current);
					} catch {
						return pathnameRef.current;
					}
				})();
				if (currentPath === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$workspace/dir/$",
					params: { namespace, workspace: workspaceSlug, _splat: splat },
					search,
				});
				return;
			}
			const filePath = event.filePath?.replace(/^\/+/, "") ?? "";
			if (!filePath || routeFilePathRef.current === filePath) return;
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
		let activeLix: WorkspaceLixSession | null = null;
		setInstance(null);
		setBranchSession(null);
		setWorkspaceDefaultBranchId(null);
		setError(null);
		routeSyncedRef.current = false;

		const userId = isDemoModeEnabled
			? DEMO_AUTH_TOKEN
			: canEdit
				? user?.id
				: `public:${workspaceId}`;
		if (!userId) {
			setError("Unable to identify the current Atelier account.");
			return;
		}
		const openingBranchId = branchIdRef.current ?? null;
		void openWorkspaceLixSession({
			namespace,
			workspaceSlug,
			getAccessToken,
			allowAnonymous: isReadOnly,
			initialBranchId: openingBranchId,
		})
			.then(async (session) => {
				if (disposed) {
					await session.close();
					return;
				}
				activeLix = session;
				activeLixRef.current = session;
				setWorkspaceDefaultBranchId(session.defaultBranchSnapshot());
				const workspaceBranchSession = createWorkspaceBranchSession({
					session,
					onSwitch: async (nextBranchId, context) => {
						const routedBranchId = resolveAtelierRouteBranchId(
							branchIdRef.current,
							session.defaultBranchSnapshot(),
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
				setBranchSession(workspaceBranchSession);
				setInstance(
					createAtelier({
						lix: session.lix,
						readOnly: isReadOnly,
						branchSession: workspaceBranchSession,
						reviewRangeSessionId: userId,
						extensions: lixrayWorkspaceExtensions,
						filesViewMode: "sidebar",
						centralPanel: {
							mode: "tabs",
							home: { extensionId: LIXRAY_HOME_EXTENSION_ID },
						},
						sessionStateStore: createWorkspaceSessionStateStore({
							userId,
							workspaceId,
						}),
						preferencesStore: createWorkspacePreferencesStore({
							client: canEdit ? client : null,
							userId,
							workspaceId,
						}),
						reviewStatusStore: createWorkspaceReviewStatusStore({
							client: canEdit ? client : null,
							userId,
							workspaceId,
						}),
						onEvent: (event) => eventHandlerRef.current(event),
					}),
				);
				captureTelemetry("workspace_opened");
				const actualBranchId = session.activeBranchSnapshot();
				if (
					shouldNormalizeInitialBranch({
						openingBranchId,
						currentBranchId: branchIdRef.current ?? null,
						actualBranchId,
						defaultBranchId: session.defaultBranchSnapshot(),
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
			const session = activeLix;
			activeLix = null;
			activeLixRef.current = null;
			if (session) void session.close();
		};
	}, [
		client,
		canEdit,
		isReadOnly,
		getAccessToken,
		navigateToCurrentPathBranch,
		namespace,
		user?.id,
		workspaceId,
		workspaceSlug,
	]);

	useEffect(() => {
		const lix = activeLixRef.current;
		if (!branchSession || !lix) return;
		const requestedBranchId = resolveAtelierRouteBranchId(
			branchId,
			lix.defaultBranchSnapshot(),
		);
		const routeSwitch = ++routeBranchSwitchRef.current;
		void (async () => {
			try {
				await branchSession.switchBranch(requestedBranchId);
			} catch (caught) {
				if (routeSwitch !== routeBranchSwitchRef.current) return;
				if (!isLixBranchNotFoundError(caught)) {
					console.error(
						"Unable to switch to the requested Atelier branch",
						caught,
					);
					// The route cannot converge on this branch; let tab
					// activations drive the URL again rather than freezing it.
					markRouteSynced();
					return;
				}
				const defaultBranchId = lix.defaultBranchSnapshot();
				try {
					if (branchSession.getSnapshot() !== defaultBranchId) {
						suppressBranchNavigationRef.current = true;
						try {
							await branchSession.switchBranch(defaultBranchId);
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
						markRouteSynced();
					}
				}
			}
		})();
		return () => {
			if (routeSwitch === routeBranchSwitchRef.current) {
				routeBranchSwitchRef.current += 1;
			}
		};
	}, [
		branchId,
		branchSession,
		markRouteSynced,
		navigateToCurrentPathBranch,
		pathname,
	]);

	// The workspace root URL means "the pinned Home tab is active" — content
	// tabs stay open (rule 1 of the tab model: Home never navigates or closes).
	useEffect(() => {
		if (!instance) return;
		const workspaceRoot = `/@${namespace}/${workspaceSlug}`;
		if (pathname !== workspaceRoot) return;
		void instance.views
			.open(LIXRAY_HOME_EXTENSION_ID)
			.catch((error: unknown) => {
				console.error("Unable to activate the workspace home", error);
			})
			.finally(markRouteSynced);
	}, [instance, markRouteSynced, namespace, pathname, workspaceSlug]);

	return (
		<div
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg-app"
			aria-busy={!instance && !error}
		>
			{instance ? (
				<WorkspaceDefaultBranchContext.Provider
					value={workspaceDefaultBranchId}
				>
					<WorkspaceBranchSessionContext.Provider value={branchSession}>
						<WorkspaceRouteSyncContext.Provider value={markRouteSynced}>
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
										// The two homes chain here: the namespace links up
										// to the hosted home, the workspace names itself.
										navbarCenter: (
											<span className="flex items-center gap-2 text-[13px]">
												<Link
													to="/home"
													className="font-medium text-text-secondary hover:text-text-primary"
												>
													{namespace}
												</Link>
												<span className="text-text-tertiary/60">/</span>
												<span className="font-semibold text-text-primary">
													{workspaceSlug}
												</span>
											</span>
										),
										centralTabStrip: (context) => (
											<LixrayCentralTabStrip
												context={context}
												pinnedTab={
													workspaceIsEmpty
														? { label: "Getting started", icon: Sparkles }
														: undefined
												}
												onNewTab={async () => {
													// A fresh tab opens the workspace root listing —
													// in-place navigation takes it from there.
													newTabSeqRef.current += 1;
													try {
														await instance.views.open(LIXRAY_DIR_EXTENSION_ID, {
															state: {
																...lixrayDirViewState("/"),
																atelier: { label: "New tab" },
															},
															instanceId: `${lixrayDirInstanceId("/")}#${newTabSeqRef.current}`,
															newTab: true,
														});
													} catch (caught) {
														console.error("Unable to open a new tab", caught);
													}
												}}
											/>
										),
										navbarEnd: headerActions,
									}}
								/>
								<Outlet />
							</WorkspaceAtelierContext.Provider>
						</WorkspaceRouteSyncContext.Provider>
					</WorkspaceBranchSessionContext.Provider>
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

/**
 * Child routes call this after applying their URL to the Atelier tabs;
 * until then, tab-activation events do not navigate (deep links win).
 */
export function useMarkWorkspaceRouteSynced(): () => void {
	const markRouteSynced = useContext(WorkspaceRouteSyncContext);
	return markRouteSynced ?? (() => undefined);
}

const NO_BRANCH_SUBSCRIBE = () => () => undefined;
const NO_BRANCH_SNAPSHOT = () => null;

/** The active workspace branch id, live (null before the session opens). */
export function useWorkspaceActiveBranchId(): string | null {
	const branchSession = useContext(WorkspaceBranchSessionContext);
	return useSyncExternalStore(
		branchSession?.subscribe.bind(branchSession) ?? NO_BRANCH_SUBSCRIBE,
		branchSession?.getSnapshot.bind(branchSession) ?? NO_BRANCH_SNAPSHOT,
		branchSession?.getSnapshot.bind(branchSession) ?? NO_BRANCH_SNAPSHOT,
	);
}

function WorkspaceShareControl({
	createShareToken,
	workspaceName,
	documentName,
}: {
	createShareToken: () => Promise<string>;
	workspaceName: string;
	documentName: string;
}) {
	const [open, setOpen] = useState(false);
	const [minting, setMinting] = useState(false);
	const [urls, setUrls] = useState({ canonicalUrl: "", editableUrl: "" });

	const mintShareLink = async () => {
		if (minting) return;
		setMinting(true);
		try {
			const token = await createShareToken();
			const canonicalUrl = stripInviteFromUrl(window.location.href);
			setUrls({
				canonicalUrl,
				editableUrl: appendWorkspaceShareToken(canonicalUrl, token),
			});
			setOpen(true);
		} catch (caught) {
			toast.error(
				caught instanceof Error
					? caught.message
					: "Unable to create a share link.",
			);
		} finally {
			setMinting(false);
		}
	};

	return (
		<WorkspaceShareDialog
			canonicalUrl={urls.canonicalUrl}
			editableUrl={urls.editableUrl}
			documentName={documentName}
			workspaceName={workspaceName}
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					setOpen(false);
					return;
				}
				void mintShareLink();
			}}
			trigger={
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="h-7 px-3"
					disabled={minting}
				>
					{minting ? "Creating…" : "Share"}
				</Button>
			}
		/>
	);
}

function activeDocumentName({
	pathname,
	routeFilePath,
	workspaceName,
}: {
	pathname: string;
	routeFilePath: string | undefined;
	workspaceName: string;
}) {
	const encodedPath = routeFilePath || pathname.split("/file/", 2)[1];
	const encodedName = encodedPath?.split("/").filter(Boolean).at(-1);
	if (!encodedName) return workspaceName;
	try {
		return decodeURIComponent(encodedName);
	} catch {
		return encodedName;
	}
}
