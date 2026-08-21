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
import { AccountMenu } from "~/components/account-menu";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import type { RepositorySettingsApi } from "~/components/repository-home/settings-view";
import { RepositoryPicker } from "~/components/repository-picker";
import {
	RepositoryShareDialog,
	type ReadShareAccess,
} from "~/components/repository-share-dialog";
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
	type RepositoryMigrationState,
	type RepositoryLixSession,
} from "~/lib/repository-lix-session";
import { formatRepositoryOpenError } from "~/lib/repository-open-error";
import {
	LIXRAY_DIR_EXTENSION_ID,
	LIXRAY_HOME_EXTENSION_ID,
	LIXRAY_PEOPLE_EXTENSION_ID,
	LIXRAY_SETTINGS_EXTENSION_ID,
	createLixrayRepositoryExtensions,
	lixrayHomeDirState,
} from "~/components/repository-home/host-extensions";
import type {
	TeamMember,
	RepositoryTeamApi,
} from "~/components/repository-home/people-view";
import { isTeamInviteToken } from "~/lib/team-invite";
import { EntryKind } from "~/lib/entry-kind";
import {
	markRepositoryOpenPerformance,
	REPOSITORY_OPEN_MARKS,
	resetRepositoryOpenPerformance,
} from "~/lib/repository-open-performance";

interface RepositoryAtelierProps {
	repositoryId: string;
	namespaceId: string;
	namespace: string;
	repositorySlug: string;
	repositoryName: string;
	repositoryVisibility: "private" | "public";
	branchId?: string;
	/** The only mode allowed to make repository mutations in this view. */
	canEdit: boolean;
	/** Set for a private repository opened through a published file/directory URL. */
	publicPath?: string;
	/** Present only for a valid, session-held share capability. */
	shareAccess?: {
		onJoinToEdit: () => Promise<void>;
		joining: boolean;
	};
}

const RepositoryAtelierContext = createContext<AtelierInstance | null>(null);
const RepositoryDefaultBranchContext = createContext<string | null>(null);
const RepositoryRouteSyncContext = createContext<(() => void) | null>(null);
const RepositoryShellDirNavigationContext = createContext<
	((dirPath: string) => boolean) | null
>(null);
const RepositoryBranchSessionContext =
	createContext<RepositoryBranchSession | null>(null);

export function RepositoryAtelier({
	repositoryId,
	namespaceId,
	namespace,
	repositorySlug,
	repositoryName,
	repositoryVisibility,
	branchId,
	canEdit,
	publicPath,
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
	// `canEdit` is the protocol-principal split: members handshake as
	// Authenticated(user.id); public readers handshake as Anonymous
	// (`public:${repositoryId}`), including signed-in non-members whose JWT
	// is stripped by the worker before lix-server. Mixing those on one
	// session id is ACCOUNT_MISMATCH 403, not SESSION_GONE 410.
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
	const routeChildKind: "file" | "dir" | "team" | "settings" | "sql" | null =
		pathname.startsWith(`${repositoryRootPath}/file/`)
			? "file"
			: pathname.startsWith(`${repositoryRootPath}/dir/`)
				? "dir"
				: pathname === `${repositoryRootPath}/team`
					? "team"
					: pathname === `${repositoryRootPath}/settings`
						? "settings"
						: pathname === `${repositoryRootPath}/sql`
							? "sql"
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
	const [migration, setMigration] = useState<RepositoryMigrationState | null>(
		null,
	);
	const activeLixRef = useRef<RepositoryLixSession | null>(null);
	const pathnameRef = useRef(pathname);
	const routeChildRef = useRef<{
		kind: "file" | "dir" | "team" | "settings" | "sql" | null;
		splat: string | undefined;
	}>({ kind: routeChildKind, splat: routeSplat });
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
	const { organizations, renameRepository, deleteRepository, refresh } =
		useRepository();
	const activeOrganization = organizations.find(
		(candidate) => candidate.id === namespaceId,
	);
	const activeRepository = activeOrganization?.repositories.find(
		(candidate) => candidate.id === repositoryId,
	);
	const isRepositoryAdmin = activeRepository?.role === "admin";
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
						role: "admin",
						isSelf: true,
					},
				],
				token: randomRepositoryInviteToken(),
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
						canManageMembers: () => true,
						listMembers: () => Promise.resolve([...demoTeamState().members]),
						inviteUrl: () => Promise.resolve(demoInviteUrl()),
						resetInviteUrl: () => {
							demoTeamState().token = randomRepositoryInviteToken();
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
						canManageMembers: () => Boolean(isRepositoryAdmin),
						listMembers: async (): Promise<readonly TeamMember[]> => {
							const { data, error } = await client.rpc("list_lix_members", {
								p_lix_id: repositoryId,
							});
							if (error) throw new Error(error.message);
							return data.map((row) => ({
								userId: row.user_id,
								name: row.name,
								email: row.email,
								avatarUrl: row.avatar_url,
								role: row.role,
								isSelf: row.user_id === user?.id,
							}));
						},
						inviteUrl: async () => {
							const { data, error } = await client.rpc("get_lix_invite_link", {
								p_lix_id: repositoryId,
							});
							if (error) throw new Error(error.message);
							if (!isRepositoryShareToken(data) || isTeamInviteToken(data)) {
								throw new Error("The invite service returned an invalid link.");
							}
							return appendRepositoryShareToken(
								`${window.location.origin}/@${namespace}/${repositorySlug}`,
								data,
							);
						},
						resetInviteUrl: async () => {
							const { data, error } = await client.rpc(
								"reset_lix_invite_link",
								{
									p_lix_id: repositoryId,
								},
							);
							if (error) throw new Error(error.message);
							if (!isRepositoryShareToken(data) || isTeamInviteToken(data)) {
								throw new Error("The invite service returned an invalid link.");
							}
							return appendRepositoryShareToken(
								`${window.location.origin}/@${namespace}/${repositorySlug}`,
								data,
							);
						},
						removeMember: async (userId: string) => {
							const { error } = await client.rpc("remove_lix_member", {
								p_lix_id: repositoryId,
								p_user_id: userId,
							});
							if (error) throw new Error(error.message);
						},
					};
	});
	const stableTeamApiRef = useRef<RepositoryTeamApi>({
		namespaceHandle: () => teamApiRef.current?.namespaceHandle() ?? "",
		canManageMembers: () => teamApiRef.current?.canManageMembers() ?? false,
		listMembers: () => requireTeamApi(teamApiRef.current).listMembers(),
		inviteUrl: () => requireTeamApi(teamApiRef.current).inviteUrl(),
		resetInviteUrl: () => requireTeamApi(teamApiRef.current).resetInviteUrl(),
		removeMember: (userId) =>
			requireTeamApi(teamApiRef.current).removeMember(userId),
	});

	// Same rebuilt-per-render / stable-facade split for the Settings tab.
	const settingsApiRef = useRef<RepositorySettingsApi | null>(null);
	useEffect(() => {
		settingsApiRef.current =
			!canEdit || isDemoModeEnabled || !client
				? null
				: {
						info: () => ({
							namespaceHandle: namespace,
							repositorySlug,
							repositoryName: activeRepository?.name ?? repositoryName,
							isAdmin: Boolean(isRepositoryAdmin),
							visibility: activeRepository?.visibility ?? "private",
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
								role: row.role,
							}));
						},
						removeDirectMember: async (memberUserId) => {
							const { error } = await client.rpc("remove_lix_member", {
								p_lix_id: repositoryId,
								p_user_id: memberUserId,
							});
							if (error) throw new Error(error.message);
						},
						setMemberRole: async (memberUserId, role) => {
							const { error } = await client.rpc("set_lix_member_role", {
								p_lix_id: repositoryId,
								p_user_id: memberUserId,
								p_role: role,
							});
							if (error) throw new Error(error.message);
						},
						setVisibility: async (visibility) => {
							const { error } = await client.rpc("set_lix_visibility", {
								p_lix_id: repositoryId,
								p_visibility: visibility,
							});
							if (error) throw new Error(error.message);
						},
						getInviteLink: async () => {
							const { data, error } = await client.rpc("get_lix_invite_link", {
								p_lix_id: repositoryId,
							});
							if (error) throw new Error(error.message);
							if (!isRepositoryShareToken(data) || isTeamInviteToken(data)) {
								throw new Error("The invite service returned an invalid link.");
							}
							return appendRepositoryShareToken(
								`${window.location.origin}/@${namespace}/${repositorySlug}`,
								data,
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
				isAdmin: false,
				visibility: "private",
				currentUserId: null,
			},
		rename: (name) => requireSettingsApi(settingsApiRef.current).rename(name),
		listDirectMembers: () =>
			requireSettingsApi(settingsApiRef.current).listDirectMembers(),
		removeDirectMember: (memberUserId) =>
			requireSettingsApi(settingsApiRef.current).removeDirectMember(
				memberUserId,
			),
		setMemberRole: (memberUserId, role) =>
			requireSettingsApi(settingsApiRef.current).setMemberRole(
				memberUserId,
				role,
			),
		setVisibility: (visibility) =>
			requireSettingsApi(settingsApiRef.current).setVisibility(visibility),
		getInviteLink: () =>
			requireSettingsApi(settingsApiRef.current).getInviteLink(),
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
	const repositoryHeaderActions = canEdit ? (
		client ? (
			<RepositoryShareControl
				loadReadAccess={async () => {
					const resourcePath =
						routeChildKind === "file" || routeChildKind === "dir"
							? normalizedRouteResourcePath(routeSplat)
							: "/";
					const { data: resolved, error: resolveError } = await client.rpc(
						"resolve_public_lix",
						{ p_lix_id: repositoryId, p_path: resourcePath },
					);
					if (resolveError) throw resolveError;
					const currentAccess = resolved?.[0];
					if (!currentAccess)
						throw new Error("Repository access is unavailable.");

					if (currentAccess.visibility === "public") {
						return {
							status: "published",
							source: "repository",
							canUnpublish:
								routeChildKind === null && currentAccess.role === "admin",
						};
					}
					if (routeChildKind !== "file" && routeChildKind !== "dir") {
						return {
							status: "private",
							canPublish: currentAccess.role === "admin",
						};
					}

					const path = resourcePath;
					const { data, error } = await client.rpc("list_lix_publications", {
						p_lix_id: repositoryId,
					});
					if (error) throw error;
					const kind = routeChildKind === "file" ? "file" : "directory";
					if (
						data?.some(
							(publication) =>
								publication.path === path && publication.kind === kind,
						)
					) {
						return {
							status: "published",
							source: "resource",
							canUnpublish: true,
						};
					}
					const ancestor = data
						?.filter(
							(publication) =>
								publication.kind === "directory" &&
								(publication.path === "/" ||
									path === publication.path ||
									path.startsWith(`${publication.path}/`)),
						)
						.sort((left, right) => right.path.length - left.path.length)[0];
					if (ancestor) {
						return {
							status: "published",
							source: "ancestor",
							canUnpublish: false,
							inheritedFrom:
								ancestor.path === "/"
									? "the published root folder"
									: `the published folder ${ancestor.path}`,
						};
					}
					return { status: "private", canPublish: true };
				}}
				publishReadLink={async () => {
					if (routeChildKind === "file" || routeChildKind === "dir") {
						const path = normalizedRouteResourcePath(routeSplat);
						const { error } = await client.rpc("publish_lix_resource", {
							p_lix_id: repositoryId,
							p_path: path,
							p_kind: routeChildKind === "file" ? "file" : "directory",
						});
						if (error) throw error;
						return;
					}
					const { error } = await client.rpc("set_lix_visibility", {
						p_lix_id: repositoryId,
						p_visibility: "public",
					});
					if (error) throw error;
					await refresh({ organizationId: namespaceId, repositoryId });
				}}
				unpublishReadLink={async () => {
					if (routeChildKind === "file" || routeChildKind === "dir") {
						const { error } = await client.rpc("unpublish_lix_resource", {
							p_lix_id: repositoryId,
							p_path: normalizedRouteResourcePath(routeSplat),
							p_kind: routeChildKind === "file" ? "file" : "directory",
						});
						if (error) throw error;
						return;
					}
					const { error } = await client.rpc("set_lix_visibility", {
						p_lix_id: repositoryId,
						p_visibility: "private",
					});
					if (error) throw error;
					await refresh({ organizationId: namespaceId, repositoryId });
				}}
				publicationLabel={
					routeChildKind === "file"
						? "file"
						: routeChildKind === "dir"
							? "folder"
							: "repository"
				}
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
	const headerActions = (
		<div className="flex items-center gap-2">
			{repositoryHeaderActions}
			{user ? <AccountMenu className="size-7" /> : null}
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
			if (routeChild.kind === "sql") {
				await navigate({
					to: "/@{$namespace}/$repository/sql",
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
	// The folder path of the last /dir navigation this handler issued. The
	// dir route consumes it to tell shell-originated URL changes (the right
	// view is already active — e.g. a forked folder tab) from outside ones
	// (deep link, back/forward), which must hydrate the Home surface.
	const shellDirNavigationRef = useRef<string | null>(null);
	const consumeShellDirNavigation = useCallback((dirPath: string) => {
		const matches = shellDirNavigationRef.current === dirPath;
		shellDirNavigationRef.current = null;
		return matches;
	}, []);
	useEffect(() => {
		eventHandlerRef.current = (event) => {
			atelierTelemetryHandlerRef.current?.(event);
			if (event.type !== "central_view_activated") return;
			if (!routeSyncedRef.current) return;
			// Any activation supersedes an unconsumed dir-navigation marker.
			shellDirNavigationRef.current = null;
			const activeBranchId = activeLixRef.current?.activeBranchSnapshot();
			const defaultBranchId = activeLixRef.current?.defaultBranchSnapshot();
			const search =
				activeBranchId && defaultBranchId
					? atelierBranchSearch(activeBranchId, defaultBranchId)
					: {};
			if (event.viewKind === LIXRAY_HOME_EXTENSION_ID) {
				// Home is the primary Files surface (flow A): drilled into a
				// folder it claims the /dir URL, at the root it claims the
				// repository root URL.
				const state = event.state;
				const dirPath =
					state &&
					(state.kind === undefined || state.kind === EntryKind.Directory) &&
					typeof state.path === "string"
						? state.path
						: "/";
				const splat = dirPath.replace(/^\/+/, "");
				if (splat) {
					const targetPath = `/@${namespace}/${repositorySlug}/dir/${splat}`;
					const currentPath = (() => {
						try {
							return decodeURIComponent(pathnameRef.current);
						} catch {
							return pathnameRef.current;
						}
					})();
					if (currentPath === targetPath) return;
					shellDirNavigationRef.current = `/${splat}`;
					void navigate({
						to: "/@{$namespace}/$repository/dir/$",
						params: { namespace, repository: repositorySlug, _splat: splat },
						search,
					});
					return;
				}
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
			if (event.viewKind === "sql_explorer") {
				const targetPath = `/@${namespace}/${repositorySlug}/sql`;
				if (pathnameRef.current === targetPath) return;
				void navigate({
					to: "/@{$namespace}/$repository/sql",
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
				shellDirNavigationRef.current = `/${splat}`;
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
		const openController = new AbortController();
		resetRepositoryOpenPerformance();
		setInstance(null);
		setBranchSession(null);
		setRepositoryDefaultBranchId(null);
		setError(null);
		setMigration(null);
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
			publicPath: isReadOnly ? publicPath : undefined,
			initialBranchId: openingBranchId,
			authIdentity: atelierUserId,
			signal: openController.signal,
			onMigration: (state) => {
				if (!disposed) setMigration(state);
			},
		})
			.then(async (session) => {
				if (disposed) {
					await session.close();
					return;
				}
				activeLix = session;
				setMigration(null);
				markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.sessionReady);
				activeLixRef.current = session;
				setRepositoryDefaultBranchId(session.defaultBranchSnapshot());

				// Initialize telemetry handler with repository context
				atelierTelemetryHandlerRef.current = createAtelierTelemetryHandler(
					captureTelemetry,
					{
						context: {
							lix: session.lix,
							repositoryId,
							organizationId: namespaceId,
						},
					},
				);

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
						repositoryVisibility,
					),
					centralPanel: {
						home: { extensionId: LIXRAY_HOME_EXTENSION_ID },
					},
					sessionStateStore: createRepositorySessionStateStore({
						userId: atelierUserId,
						repositoryId,
					}),
					preferencesStore: createRepositoryPreferencesStore({
						userId: atelierUserId,
						repositoryId,
					}),
					reviewStatusStore: createRepositoryReviewStatusStore({
						userId: atelierUserId,
						repositoryId,
					}),
					onEvent: (event) => eventHandlerRef.current(event),
				});
				markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.atelierReady);
				setInstance(atelierInstance);
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
					setMigration(null);
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
			openController.abort();
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
		publicPath,
		navigateToCurrentPathBranch,
		namespace,
		namespaceId,
		repositoryId,
		repositoryName,
		repositorySlug,
		repositoryVisibility,
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
		// The state reset matters as much as the activation: Home may be
		// drilled into a folder (flow A), and the root URL means the root
		// listing.
		void instance.views
			.open(LIXRAY_HOME_EXTENSION_ID, { state: lixrayHomeDirState("/") })
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
							<RepositoryShellDirNavigationContext.Provider
								value={consumeShellDirNavigation}
							>
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
													namespaceHandle={namespace}
													repositoryName={repositoryName}
													repositorySlug={repositorySlug}
												/>
											),
											navbarEnd: headerActions,
										}}
									/>
									<Outlet />
								</RepositoryAtelierContext.Provider>
							</RepositoryShellDirNavigationContext.Provider>
						</RepositoryRouteSyncContext.Provider>
					</RepositoryBranchSessionContext.Provider>
				</RepositoryDefaultBranchContext.Provider>
			) : null}
			{!instance && !error && migration ? (
				<main className="absolute inset-0 grid place-content-center justify-items-center gap-3 bg-bg-app p-6 text-center text-text-secondary">
					<strong>Migrating repository…</strong>
					<span className="text-sm text-text-tertiary">
						Updating the repository from v{migration.fromVersion} to v
						{migration.toVersion}. This happens automatically.
					</span>
					<div
						className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-border-subtle"
						role="progressbar"
						aria-label="Repository migration"
						aria-valuetext="Migration in progress"
					>
						<div className="h-full w-1/3 animate-pulse rounded-full bg-text-secondary" />
					</div>
				</main>
			) : null}
			{!instance && !error && !migration ? (
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

/**
 * True when the current /dir URL was just written by a tab activation inside
 * the shell — the right Files surface is already active, so the dir route
 * must not hydrate Home over it (it would steal focus from a forked folder
 * tab). Consuming clears the marker; outside navigations (deep link,
 * back/forward) never match and hydrate as usual.
 */
export function useConsumeShellDirNavigation(): (dirPath: string) => boolean {
	const consume = useContext(RepositoryShellDirNavigationContext);
	return consume ?? (() => false);
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

function randomRepositoryInviteToken(): string {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	let token = "ri_";
	for (const byte of bytes) token += alphabet[byte & 63];
	return token;
}

function RepositoryShareControl({
	loadReadAccess,
	publishReadLink,
	unpublishReadLink,
	publicationLabel,
	documentName,
	onOpenTeam,
}: {
	loadReadAccess: () => Promise<ReadShareAccess>;
	publishReadLink: () => Promise<void>;
	unpublishReadLink: () => Promise<void>;
	publicationLabel: "file" | "folder" | "repository";
	documentName: string;
	onOpenTeam?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [readAccess, setReadAccess] = useState<ReadShareAccess | null>(null);
	const [canonicalUrl, setCanonicalUrl] = useState("");

	const openShare = () => {
		setCanonicalUrl(stripInviteFromUrl(window.location.href));
		setReadAccess(null);
		setOpen(true);
		void loadReadAccess()
			.then(setReadAccess)
			.catch((caught: unknown) => {
				toast.error(
					caught instanceof Error
						? caught.message
						: "Unable to load sharing status.",
				);
				setOpen(false);
			});
	};

	return (
		<RepositoryShareDialog
			canonicalUrl={canonicalUrl}
			documentName={documentName}
			publicationLabel={publicationLabel}
			readAccess={readAccess}
			publishReadLink={async () => {
				await publishReadLink();
				setReadAccess({
					status: "published",
					source: publicationLabel === "repository" ? "repository" : "resource",
					canUnpublish: true,
				});
				captureTelemetry("webapp_resource_published", {
					resource_kind: publicationLabel,
				});
			}}
			unpublishReadLink={async () => {
				await unpublishReadLink();
				setReadAccess({ status: "private", canPublish: true });
				captureTelemetry("webapp_resource_unpublished", {
					resource_kind: publicationLabel,
				});
			}}
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
				openShare();
			}}
			onCopied={() => {
				captureTelemetry("webapp_share_link_copied", { share_mode: "public" });
			}}
			trigger={
				<Button type="button" size="xs" variant="outline" className="h-7 px-3">
					Share
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

function normalizedRouteResourcePath(routeSplat: string | undefined) {
	const path = (routeSplat ?? "").replace(/^\/+|\/+$/g, "");
	return path ? `/${path}` : "/";
}
