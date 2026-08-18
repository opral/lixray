import {
	Atelier,
	createAtelier,
	type AtelierEvent,
	type AtelierInstance,
} from "@opral/atelier";
import "@opral/atelier/style.css";
import {
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
import { PencilLine } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import type { RepositorySettingsApi } from "~/components/repository-home/settings-view";
import { RepositoryPicker } from "~/components/repository-picker";
import { RepositoryShareDialog } from "~/components/repository-share-dialog";
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
	createRepositoryBranchSession,
	createRepositoryPreferencesStore,
	createRepositoryReviewStatusStore,
	createRepositorySessionStateStore,
	type RepositoryBranchSession,
} from "~/lib/atelier-state";
import { captureExceptionTelemetry, captureTelemetry } from "~/lib/telemetry";
import {
	appendRepositoryShareToken,
	canonicalPathFromLocation,
	stripInviteFromUrl,
} from "~/lib/repository-share-url";
import { isRepositoryShareToken } from "~/lib/repository-share-capability";
import {
	openRepositoryLixSession,
	type RepositoryLixSession,
} from "~/lib/repository-lix-session";
import { formatRepositoryOpenError } from "~/lib/repository-open-error";
import {
	LIXRAY_DIR_EXTENSION_ID,
	LIXRAY_HOME_EXTENSION_ID,
	LIXRAY_PEOPLE_EXTENSION_ID,
	LIXRAY_SETTINGS_EXTENSION_ID,
	createLixrayRepositoryExtensions,
	emptyRepositoryOpeningUiState,
} from "~/components/repository-home/host-extensions";
import type {
	TeamMember,
	RepositoryTeamApi,
} from "~/components/repository-home/people-view";
import { isTeamInviteToken, randomTeamInviteToken } from "~/lib/team-invite";
import { EntryKind } from "~/lib/entry-kind";
import { repositoryHasNoFiles } from "~/components/repository-home/lix-data";

interface RepositoryAtelierProps {
	repositoryId: string;
	namespaceId: string;
	namespace: string;
	repositorySlug: string;
	repositoryName: string;
	branchId?: string;
	/** The only mode allowed to make repository mutations in this view. */
	canEdit: boolean;
	/** Present only for a valid, session-held share capability. */
	shareAccess?: {
		onJoinToEdit: () => Promise<void>;
		joining: boolean;
	};
}

const RepositoryAtelierContext = createContext<AtelierInstance | null>(null);
const RepositoryDefaultBranchContext = createContext<string | null>(null);
const RepositoryRouteSyncContext = createContext<(() => void) | null>(null);
const RepositoryBranchSessionContext =
	createContext<RepositoryBranchSession | null>(null);

export function RepositoryAtelier({
	repositoryId,
	namespaceId,
	namespace,
	repositorySlug,
	repositoryName,
	branchId,
	canEdit,
	shareAccess,
}: RepositoryAtelierProps) {
	const {
		client,
		getAccessToken: getSessionAccessToken,
		isLoaded: isAuthLoaded,
		refreshSession,
		signInWithGoogle,
		user,
	} = useAuth();
	// Supabase may replace the Session/User objects when a background tab resumes.
	// Keep the open Lix session keyed to identity so token refreshes do not reopen it.
	const atelierUserId = isDemoModeEnabled
		? DEMO_AUTH_TOKEN
		: canEdit
			? user?.id
			: `public:${repositoryId}`;
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const routeParams = useParams({ strict: false });
	const routeSplat = "_splat" in routeParams ? routeParams._splat : undefined;
	const repositoryRootPath = `/@${namespace}/${repositorySlug}`;
	const routeChildKind: "file" | "dir" | "team" | "settings" | null =
		pathname.startsWith(`${repositoryRootPath}/file/`)
			? "file"
			: pathname.startsWith(`${repositoryRootPath}/dir/`)
				? "dir"
				: pathname === `${repositoryRootPath}/team`
					? "team"
					: pathname === `${repositoryRootPath}/settings`
						? "settings"
						: null;
	const routeFilePath = routeChildKind === "file" ? routeSplat : undefined;
	const documentName = activeDocumentName({
		pathname,
		routeFilePath,
		repositoryName,
	});
	const isReadOnly = !canEdit;
	const [instance, setInstance] = useState<AtelierInstance | null>(null);
	const [branchSession, setBranchSession] =
		useState<RepositoryBranchSession | null>(null);
	const [repositoryDefaultBranchId, setRepositoryDefaultBranchId] = useState<
		string | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const activeLixRef = useRef<RepositoryLixSession | null>(null);
	const pathnameRef = useRef(pathname);
	const routeChildRef = useRef<{
		kind: "file" | "dir" | "team" | "settings" | null;
		splat: string | undefined;
	}>({ kind: routeChildKind, splat: routeSplat });
	const routeFilePathRef = useRef(routeFilePath);
	const branchIdRef = useRef(branchId);
	const routeBranchSwitchRef = useRef(0);
	const suppressBranchNavigationRef = useRef(false);
	// Instance whose session state was seeded with the Getting started tab;
	// the first root-URL sync must not clobber that seed by forcing Home.
	const emptyRepositorySeededRef = useRef<AtelierInstance | null>(null);
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
	const refreshAccessToken = useCallback(async () => {
		await refreshSession();
		return getAccessToken();
	}, [getAccessToken, refreshSession]);
	const signInToCurrentRepository = useCallback(async () => {
		try {
			await signInWithGoogle(canonicalPathFromLocation(window.location));
		} catch (caught) {
			toast.error(
				caught instanceof Error ? caught.message : "Unable to start sign-in.",
			);
		}
	}, [signInWithGoogle]);
	// The raw team api is rebuilt after every render so its closures always see
	// the current Supabase client and user; the stable facade below is what the
	// long-lived Atelier extension mounts capture. The demo deployment has no
	// Supabase, so it gets an in-memory stand-in and the same UI.
	const teamApiRef = useRef<RepositoryTeamApi | null>(null);
	const demoTeamStateRef = useRef<{
		members: TeamMember[];
		token: string;
	} | null>(null);
	useEffect(() => {
		const demoTeamState = () =>
			(demoTeamStateRef.current ??= {
				members: [
					{
						userId: user?.id ?? "demo-user",
						name:
							(user?.user_metadata as { full_name?: string } | undefined)
								?.full_name ?? "Preview user",
						email: user?.email ?? "preview-user@lixray.invalid",
						avatarUrl: null,
						isSelf: true,
					},
				],
				token: "tm_preview-demo-invite",
			});
		const demoInviteUrl = () =>
			appendRepositoryShareToken(
				`${window.location.origin}/@${namespace}/${repositorySlug}`,
				demoTeamState().token,
			);
		teamApiRef.current = !canEdit
			? null
			: isDemoModeEnabled || !client
				? {
						namespaceHandle: () => namespace,
						listMembers: () => Promise.resolve([...demoTeamState().members]),
						inviteUrl: () => Promise.resolve(demoInviteUrl()),
						resetInviteUrl: () => {
							demoTeamState().token = randomTeamInviteToken();
							return Promise.resolve(demoInviteUrl());
						},
						removeMember: (userId) => {
							const state = demoTeamState();
							state.members = state.members.filter(
								(member) => member.userId !== userId || member.isSelf,
							);
							return Promise.resolve();
						},
					}
				: {
						namespaceHandle: () => namespace,
						listMembers: async (): Promise<readonly TeamMember[]> => {
							const { data, error } = await client.rpc(
								"list_namespace_members",
								{
									p_namespace_id: namespaceId,
								},
							);
							if (error) throw new Error(error.message);
							return data.map((row) => ({
								userId: row.user_id,
								name: row.name,
								email: row.email,
								avatarUrl: row.avatar_url,
								isSelf: row.user_id === user?.id,
							}));
						},
						inviteUrl: async () => {
							const { data, error } = await client.rpc(
								"get_namespace_invite_link",
								{ p_namespace_id: namespaceId },
							);
							if (error) throw new Error(error.message);
							if (!isTeamInviteToken(data)) {
								throw new Error("The invite service returned an invalid link.");
							}
							return appendRepositoryShareToken(
								`${window.location.origin}/@${namespace}/${repositorySlug}`,
								data,
							);
						},
						resetInviteUrl: async () => {
							const { data, error } = await client.rpc(
								"reset_namespace_invite_link",
								{ p_namespace_id: namespaceId },
							);
							if (error) throw new Error(error.message);
							if (!isTeamInviteToken(data)) {
								throw new Error("The invite service returned an invalid link.");
							}
							return appendRepositoryShareToken(
								`${window.location.origin}/@${namespace}/${repositorySlug}`,
								data,
							);
						},
						removeMember: async (userId: string) => {
							const { error } = await client.rpc("remove_namespace_member", {
								p_namespace_id: namespaceId,
								p_user_id: userId,
							});
							if (error) throw new Error(error.message);
						},
					};
	});
	const stableTeamApiRef = useRef<RepositoryTeamApi>({
		namespaceHandle: () => teamApiRef.current?.namespaceHandle() ?? "",
		listMembers: () => requireTeamApi(teamApiRef.current).listMembers(),
		inviteUrl: () => requireTeamApi(teamApiRef.current).inviteUrl(),
		resetInviteUrl: () => requireTeamApi(teamApiRef.current).resetInviteUrl(),
		removeMember: (userId) =>
			requireTeamApi(teamApiRef.current).removeMember(userId),
	});

	// Same rebuilt-per-render / stable-facade split for the Settings tab.
	const { organizations, renameRepository, deleteRepository } = useRepository();
	const settingsApiRef = useRef<RepositorySettingsApi | null>(null);
	useEffect(() => {
		const organization = organizations.find(
			(candidate) => candidate.id === namespaceId,
		);
		const isOwner = organization?.role === "owner";
		settingsApiRef.current =
			!canEdit || isDemoModeEnabled || !client
				? null
				: {
						info: () => ({
							namespaceHandle: namespace,
							repositorySlug,
							repositoryName:
								organization?.repositories.find(
									(candidate) => candidate.id === repositoryId,
								)?.name ?? repositoryName,
							isOwner: Boolean(isOwner),
							currentUserId: user?.id ?? null,
						}),
						rename: (name) => renameRepository(repositoryId, name),
						listDirectMembers: async () => {
							const { data, error } = await client.rpc("list_lix_members", {
								p_lix_id: repositoryId,
							});
							if (error) throw new Error(error.message);
							return (data ?? []).map((row) => ({
								userId: row.user_id,
								name: row.name,
								email: row.email,
								avatarUrl: row.avatar_url,
							}));
						},
						removeDirectMember: async (memberUserId) => {
							const { error } = await client.rpc("remove_lix_member", {
								p_lix_id: repositoryId,
								p_user_id: memberUserId,
							});
							if (error) throw new Error(error.message);
						},
						namespaceMemberCount: async () => {
							if (!organization || organization.role === null) return null;
							const { data, error } = await client.rpc(
								"list_namespace_members",
								{ p_namespace_id: namespaceId },
							);
							if (error) return null;
							return (data ?? []).length;
						},
						createEditLink: async () => {
							const { data, error } = await client.rpc(
								"create_lix_share_token",
								{ p_lix_id: repositoryId },
							);
							if (error) throw new Error(error.message);
							const token = data?.[0]?.token;
							if (!isRepositoryShareToken(token)) {
								throw new Error("The share service returned an invalid link.");
							}
							return appendRepositoryShareToken(
								`${window.location.origin}/@${namespace}/${repositorySlug}`,
								token,
							);
						},
						deleteRepository: async () => {
							await deleteRepository(repositoryId);
							void navigate({ to: "/home" });
						},
					};
	});
	const stableSettingsApiRef = useRef<RepositorySettingsApi>({
		info: () =>
			settingsApiRef.current?.info() ?? {
				namespaceHandle: namespace,
				repositorySlug,
				repositoryName,
				isOwner: false,
				currentUserId: null,
			},
		rename: (name) => requireSettingsApi(settingsApiRef.current).rename(name),
		listDirectMembers: () =>
			requireSettingsApi(settingsApiRef.current).listDirectMembers(),
		removeDirectMember: (memberUserId) =>
			requireSettingsApi(settingsApiRef.current).removeDirectMember(
				memberUserId,
			),
		namespaceMemberCount: () =>
			requireSettingsApi(settingsApiRef.current).namespaceMemberCount(),
		createEditLink: () =>
			requireSettingsApi(settingsApiRef.current).createEditLink(),
		deleteRepository: () =>
			requireSettingsApi(settingsApiRef.current).deleteRepository(),
	});
	const disabledShareButton = (
		<span
			aria-disabled="true"
			title="Nothing to share yet"
			className="inline-flex h-7 cursor-default items-center rounded-[7px] border border-border-panel px-3 text-xs font-semibold text-text-tertiary/70"
		>
			Share
		</span>
	);
	// Sharing is available for the whole repository as well as individual files;
	// the current browser URL is captured when the dialog is opened.
	const headerActions = canEdit ? (
		client ? (
			<RepositoryShareControl
				createShareToken={async () => {
					const { data, error } = await client.rpc("create_lix_share_token", {
						p_lix_id: repositoryId,
					});
					if (error) throw error;
					const token = data?.[0]?.token;
					if (!isRepositoryShareToken(token)) {
						throw new Error("The share service returned an invalid link.");
					}
					return token;
				}}
				repositoryName={repositoryName}
				documentName={documentName}
				onOpenTeam={() => {
					void instance?.views
						.open(LIXRAY_PEOPLE_EXTENSION_ID, { newTab: true })
						.catch((error: unknown) => {
							console.error("Unable to open the People tab", error);
						});
				}}
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
					onClick={() => void signInToCurrentRepository()}
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
									: "Unable to join this repository.",
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
			if (routeChild.kind === "team") {
				await navigate({
					to: "/@{$namespace}/$repository/team",
					params: { namespace, repository: repositorySlug },
					search,
					replace,
				});
				return;
			}
			if (routeChild.kind === "settings") {
				await navigate({
					to: "/@{$namespace}/$repository/settings",
					params: { namespace, repository: repositorySlug },
					search,
					replace,
				});
				return;
			}
			if (routeChild.kind && routeChild.splat !== undefined) {
				await navigate({
					to:
						routeChild.kind === "dir"
							? "/@{$namespace}/$repository/dir/$"
							: "/@{$namespace}/$repository/file/$",
					params: {
						namespace,
						repository: repositorySlug,
						_splat: routeChild.splat,
					},
					search,
					replace,
				});
				return;
			}
			await navigate({
				to: "/@{$namespace}/$repository",
				params: { namespace, repository: repositorySlug },
				search,
				replace,
			});
		},
		[namespace, navigate, repositorySlug],
	);

	// URL ⇄ tabs: the URL always names the ACTIVE central view. Atelier
	// reports activations (open, tab click, close, restore); the routes below
	// drive the reverse direction. Suppressed until the initial route has been
	// applied so a restored session cannot clobber a deep link.
	const routeSyncedRef = useRef(false);
	const markRouteSynced = useCallback(() => {
		routeSyncedRef.current = true;
	}, []);
	// Each instance applies the initial route exactly once. Without the reset,
	// a deep link that raced a dying instance (dev double-mount, HMR) would
	// stay "synced", letting the next instance's restored session steal the
	// URL before the deep-linked tab ever opened.
	useEffect(() => {
		routeSyncedRef.current = false;
	}, [instance]);
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
				const targetPath = `/@${namespace}/${repositorySlug}`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$repository",
					params: { namespace, repository: repositorySlug },
					search,
				});
				return;
			}
			if (event.viewKind === LIXRAY_PEOPLE_EXTENSION_ID) {
				const targetPath = `/@${namespace}/${repositorySlug}/team`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$repository/team",
					params: { namespace, repository: repositorySlug },
					search,
				});
				return;
			}
			if (event.viewKind === LIXRAY_SETTINGS_EXTENSION_ID) {
				const targetPath = `/@${namespace}/${repositorySlug}/settings`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$repository/settings",
					params: { namespace, repository: repositorySlug },
					search,
				});
				return;
			}
			if (event.viewKind === LIXRAY_DIR_EXTENSION_ID) {
				const state = event.state;
				if (!state) return;
				if (state.kind !== undefined && state.kind !== EntryKind.Directory)
					return;
				const dirPath = state.path;
				if (typeof dirPath !== "string" || dirPath === "/") return;
				const splat = dirPath.startsWith("/") ? dirPath.slice(1) : "";
				// A root-listing tab (the strip's New tab) stays URL-less: the
				// repository root URL means "Home is active" (rule 1), so syncing
				// here would bounce the selection back to Home. The tab claims a
				// URL on its first in-place navigation instead.
				if (!splat) return;
				const targetPath = `/@${namespace}/${repositorySlug}/dir/${splat}`;
				const currentPath = (() => {
					try {
						return decodeURIComponent(pathnameRef.current);
					} catch {
						return pathnameRef.current;
					}
				})();
				if (currentPath === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$repository/dir/$",
					params: { namespace, repository: repositorySlug, _splat: splat },
					search,
				});
				return;
			}
			const filePath = event.filePath?.replace(/^\/+/, "") ?? "";
			if (!filePath || routeFilePathRef.current === filePath) return;
			void navigate({
				to: "/@{$namespace}/$repository/file/$",
				params: {
					namespace,
					repository: repositorySlug,
					_splat: filePath,
				},
				search,
			});
		};
	}, [namespace, navigate, repositorySlug]);

	useEffect(() => {
		let disposed = false;
		let activeLix: RepositoryLixSession | null = null;
		setInstance(null);
		setBranchSession(null);
		setRepositoryDefaultBranchId(null);
		setError(null);
		routeSyncedRef.current = false;

		if (!atelierUserId) {
			setError("Unable to identify the current Atelier account.");
			return;
		}
		const openingBranchId = branchIdRef.current ?? null;
		void openRepositoryLixSession({
			namespace,
			repositorySlug: repositorySlug,
			repositoryId: repositoryId,
			getAccessToken,
			refreshAccessToken,
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
				setRepositoryDefaultBranchId(session.defaultBranchSnapshot());
				const repositoryBranchSession = createRepositoryBranchSession({
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
				setBranchSession(repositoryBranchSession);
				// An empty repository defaults to the Getting started tab (12f),
				// seeded into the first-visit session state rather than opened
				// imperatively — views.open() races the shell's mount/restore.
				// This query is part of boot. If it cannot answer, the repository must
				// show the real error instead of silently taking the non-empty path.
				const startsEmpty = await repositoryHasNoFiles(session.lix);
				if (disposed) return;
				const atelierInstance = createAtelier({
					lix: session.lix,
					readOnly: isReadOnly,
					branchSession: repositoryBranchSession,
					reviewRangeSessionId: atelierUserId,
					extensions: createLixrayRepositoryExtensions(
						{
							lixId: repositoryId,
							namespace,
							lixSlug: repositorySlug,
							lixName: repositoryName,
						},
						async () => {
							if (!client || !canEdit || !atelierUserId) return false;
							if (!(await getAccessToken())) return false;
							const { data, error } = await client
								.from("mcp_lix_connections")
								.select("last_seen_at")
								.eq("lix_id", repositoryId)
								.order("last_seen_at", { ascending: false })
								.limit(1);
							if (error) throw error;
							return data.length > 0;
						},
						canEdit ? stableTeamApiRef.current : null,
						canEdit ? stableSettingsApiRef.current : null,
					),
					centralPanel: {
						home: { extensionId: LIXRAY_HOME_EXTENSION_ID },
					},
					sessionStateStore: createRepositorySessionStateStore({
						userId: atelierUserId,
						repositoryId,
						...(startsEmpty
							? { initializeSnapshot: emptyRepositoryOpeningUiState }
							: {}),
					}),
					preferencesStore: createRepositoryPreferencesStore({
						client: canEdit ? client : null,
						userId: atelierUserId,
						repositoryId,
					}),
					reviewStatusStore: createRepositoryReviewStatusStore({
						client: canEdit ? client : null,
						userId: atelierUserId,
						repositoryId,
					}),
					onEvent: (event) => eventHandlerRef.current(event),
				});
				if (startsEmpty) {
					emptyRepositorySeededRef.current = atelierInstance;
				}
				setInstance(atelierInstance);
				captureTelemetry("repository_opened");
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
					captureExceptionTelemetry(caught, {
						operation: "repository_open",
						lix_id: repositoryId,
						namespace_id: namespace,
					});
					setError(formatRepositoryOpenError(caught));
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
		atelierUserId,
		canEdit,
		isReadOnly,
		getAccessToken,
		refreshAccessToken,
		navigateToCurrentPathBranch,
		namespace,
		repositoryId,
		repositoryName,
		repositorySlug,
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

	// The repository root URL means "the pinned Home tab is active" — content
	// tabs stay open (rule 1 of the tab model: Home never navigates or closes).
	useEffect(() => {
		if (!instance) return;
		const repositoryRoot = `/@${namespace}/${repositorySlug}`;
		if (pathname !== repositoryRoot) return;
		// The first sync of a seeded empty repository keeps the Getting started
		// tab active instead of forcing Home over it (12f). Later returns to
		// the root URL activate Home as usual.
		if (emptyRepositorySeededRef.current === instance) {
			emptyRepositorySeededRef.current = null;
			markRouteSynced();
			return;
		}
		void instance.views
			.open(LIXRAY_HOME_EXTENSION_ID)
			.catch((error: unknown) => {
				console.error("Unable to activate the repository home", error);
			})
			.finally(markRouteSynced);
	}, [instance, markRouteSynced, namespace, pathname, repositorySlug]);

	return (
		<div
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg-app"
			aria-busy={!instance && !error}
		>
			{instance ? (
				<RepositoryDefaultBranchContext.Provider
					value={repositoryDefaultBranchId}
				>
					<RepositoryBranchSessionContext.Provider value={branchSession}>
						<RepositoryRouteSyncContext.Provider value={markRouteSynced}>
							<RepositoryAtelierContext.Provider value={instance}>
								<Atelier
									instance={instance}
									topBarProps={{
										"data-app-titlebar": true,
										className: "border-b border-border-subtle bg-bg-app",
									}}
									slots={{
										navbarBrand: (
											<RepositoryPicker
												namespaceId={namespaceId}
												repositoryName={repositoryName}
												repositorySlug={repositorySlug}
											/>
										),
										navbarEnd: headerActions,
									}}
								/>
								<Outlet />
							</RepositoryAtelierContext.Provider>
						</RepositoryRouteSyncContext.Provider>
					</RepositoryBranchSessionContext.Provider>
				</RepositoryDefaultBranchContext.Provider>
			) : null}
			{!instance && !error ? (
				<main className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-bg-app p-6 text-center text-text-secondary">
					Opening repository…
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

export function useRepositoryAtelierInstance(): AtelierInstance | null {
	return useContext(RepositoryAtelierContext);
}

export function useRepositoryDefaultBranchId(): string | null {
	return useContext(RepositoryDefaultBranchContext);
}

/**
 * Child routes call this after applying their URL to the Atelier tabs;
 * until then, tab-activation events do not navigate (deep links win).
 */
export function useMarkRepositoryRouteSynced(): () => void {
	const markRouteSynced = useContext(RepositoryRouteSyncContext);
	return markRouteSynced ?? (() => undefined);
}

const NO_BRANCH_SUBSCRIBE = () => () => undefined;
const NO_BRANCH_SNAPSHOT = () => null;

/** The active repository branch id, live (null before the session opens). */
export function useRepositoryActiveBranchId(): string | null {
	const branchSession = useContext(RepositoryBranchSessionContext);
	return useSyncExternalStore(
		branchSession?.subscribe.bind(branchSession) ?? NO_BRANCH_SUBSCRIBE,
		branchSession?.getSnapshot.bind(branchSession) ?? NO_BRANCH_SNAPSHOT,
		branchSession?.getSnapshot.bind(branchSession) ?? NO_BRANCH_SNAPSHOT,
	);
}

function requireSettingsApi(
	api: RepositorySettingsApi | null,
): RepositorySettingsApi {
	if (!api) throw new Error("Repository settings require edit access.");
	return api;
}

function requireTeamApi(api: RepositoryTeamApi | null): RepositoryTeamApi {
	if (!api) throw new Error("Team access requires an editable session.");
	return api;
}

function RepositoryShareControl({
	createShareToken,
	repositoryName,
	documentName,
	onOpenTeam,
}: {
	createShareToken: () => Promise<string>;
	repositoryName: string;
	documentName: string;
	onOpenTeam?: () => void;
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
				editableUrl: appendRepositoryShareToken(canonicalUrl, token),
			});
			captureTelemetry("share_link_created");
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
		<RepositoryShareDialog
			canonicalUrl={urls.canonicalUrl}
			editableUrl={urls.editableUrl}
			documentName={documentName}
			repositoryName={repositoryName}
			onOpenTeam={
				onOpenTeam
					? () => {
							setOpen(false);
							onOpenTeam();
						}
					: undefined
			}
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					setOpen(false);
					return;
				}
				void mintShareLink();
			}}
			onCopied={(_url, mode) => {
				captureTelemetry("share_link_copied", { share_mode: mode });
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
	repositoryName,
}: {
	pathname: string;
	routeFilePath: string | undefined;
	repositoryName: string;
}) {
	const encodedPath = routeFilePath || pathname.split("/file/", 2)[1];
	const encodedName = encodedPath?.split("/").filter(Boolean).at(-1);
	if (!encodedName) return repositoryName;
	try {
		return decodeURIComponent(encodedName);
	} catch {
		return encodedName;
	}
}
