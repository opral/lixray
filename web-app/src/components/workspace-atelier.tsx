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
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { WorkspaceShareDialog } from "~/components/workspace-share-dialog";
import { Button } from "~/components/ui/button";
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
import type { LixraySupabaseClient } from "~/lib/supabase";
import { captureTelemetry } from "~/lib/telemetry";
import {
	appendWorkspaceShareToken,
	canonicalPathFromLocation,
	stripInviteFromUrl,
} from "~/lib/workspace-share-url";
import { isWorkspaceShareToken } from "~/lib/workspace-share-capability";

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
		sharedByName: string | null;
		onJoinToEdit: () => Promise<void>;
		joining: boolean;
	};
}

const WorkspaceAtelierContext = createContext<AtelierInstance | null>(null);
const WorkspaceDefaultBranchContext = createContext<string | null>(null);

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
	const routeFilePath =
		"_splat" in routeParams ? routeParams._splat : undefined;
	const documentName =
		routeFilePath?.split("/").filter(Boolean).at(-1) ?? workspaceName;
	const isReadOnly = !canEdit;
	const [instance, setInstance] = useState<AtelierInstance | null>(null);
	const [workspaceDefaultBranchId, setWorkspaceDefaultBranchId] = useState<
		string | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const workspaceRootRef = useRef<HTMLDivElement | null>(null);
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
	const signInToCurrentWorkspace = useCallback(async () => {
		try {
			await signInWithGoogle(canonicalPathFromLocation(window.location));
		} catch (caught) {
			toast.error(
				caught instanceof Error ? caught.message : "Unable to start sign-in.",
			);
		}
	}, [signInWithGoogle]);
	const headerActions = canEdit ? (
		client ? (
			<WorkspaceShareControl
				client={client}
				workspaceId={workspaceId}
				workspaceName={workspaceName}
				documentName={documentName}
			/>
		) : null
	) : (
		<div className="flex items-center gap-2">
			{!user ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!isAuthLoaded}
					onClick={() => void signInToCurrentWorkspace()}
				>
					Sign in
				</Button>
			) : null}
			{shareAccess ? (
				<Button
					type="button"
					size="sm"
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
		let activeLix: BrowserLix | null = null;
		setInstance(null);
		setWorkspaceDefaultBranchId(null);
		setError(null);

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
		canEdit,
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

	useEffect(() => {
		const root = workspaceRootRef.current;
		if (!isReadOnly || !root) return;
		const lockEditorSurfaces = () => {
			for (const surface of root.querySelectorAll<HTMLElement>(
				'[contenteditable="true"]',
			)) {
				surface.setAttribute("contenteditable", "false");
				surface.setAttribute("aria-readonly", "true");
			}
			for (const input of root.querySelectorAll<HTMLTextAreaElement>(
				'[data-attr="markdown-editor"] textarea, .atelier-text-editor-host textarea',
			)) {
				input.readOnly = true;
			}
		};
		lockEditorSurfaces();
		const observer = new MutationObserver(lockEditorSurfaces);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["contenteditable"],
			childList: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [instance, isReadOnly]);

	return (
		<div
			ref={workspaceRootRef}
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg-app"
			data-workspace-read-only={isReadOnly || undefined}
			aria-busy={!instance && !error}
			onBeforeInputCapture={
				isReadOnly ? preventReadOnlyEditorMutation : undefined
			}
			onDropCapture={isReadOnly ? preventReadOnlyEditorMutation : undefined}
			onCutCapture={isReadOnly ? preventReadOnlyEditorMutation : undefined}
			onPasteCapture={isReadOnly ? preventReadOnlyEditorMutation : undefined}
			onKeyDownCapture={isReadOnly ? preventReadOnlyEditorKeys : undefined}
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
								navbarEnd: headerActions,
							}}
						/>
						{isReadOnly && shareAccess ? (
							<ReadOnlyShareStrip sharedByName={shareAccess.sharedByName} />
						) : null}
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

function WorkspaceShareControl({
	client,
	workspaceId,
	workspaceName,
	documentName,
}: {
	client: LixraySupabaseClient;
	workspaceId: string;
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
			const { data, error } = await client.rpc("create_workspace_share_token", {
				p_workspace_id: workspaceId,
			});
			if (error) throw error;
			const token = data?.[0]?.token;
			if (!isWorkspaceShareToken(token)) {
				throw new Error("The share service returned an invalid link.");
			}
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
				<Button type="button" size="sm" variant="outline" disabled={minting}>
					{minting ? "Creating…" : "Share"}
				</Button>
			}
		/>
	);
}

function ReadOnlyShareStrip({ sharedByName }: { sharedByName: string | null }) {
	return (
		<div
			className="pointer-events-none absolute inset-x-0 top-9 z-20 flex h-8 items-center gap-2 border-b border-border-subtle bg-bg-panel/95 px-4 text-xs text-text-secondary shadow-sm backdrop-blur"
			role="status"
		>
			<span className="font-medium text-text-primary">Read-only</span>
			<span aria-hidden="true">·</span>
			<span>
				shared by{" "}
				<strong className="font-medium text-text-primary">
					{sharedByName ?? "a workspace member"}
				</strong>
			</span>
		</div>
	);
}

type ReadOnlyMutationEvent = {
	target: EventTarget | null;
	preventDefault: () => void;
};

function preventReadOnlyEditorMutation(event: ReadOnlyMutationEvent) {
	if (isWorkspaceEditorTarget(event.target)) event.preventDefault();
}

function preventReadOnlyEditorKeys(
	event: ReadOnlyMutationEvent & {
		key: string;
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
	},
) {
	if (!isWorkspaceEditorTarget(event.target)) return;
	if (event.altKey) return;
	if (event.ctrlKey || event.metaKey) {
		if (["a", "c", "f"].includes(event.key.toLowerCase())) return;
		event.preventDefault();
		return;
	}
	if (
		event.key.length === 1 ||
		["Backspace", "Delete", "Enter", "Tab"].includes(event.key)
	) {
		event.preventDefault();
	}
}

function isWorkspaceEditorTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest(
			'[data-attr="markdown-editor"], .atelier-text-editor-host, .ProseMirror, .cm-editor',
		) !== null
	);
}
