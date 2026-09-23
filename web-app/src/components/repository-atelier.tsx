import { reportRepositoryOpenFailure } from "~/lib/repository-open-telemetry";
import { createRepositoryRouteLifecycle } from "~/lib/repository-route-lifecycle";
import { RepositoryUpgradeProgress } from "./repository-upgrade-progress";
import {
	createShellNavigationQueue,
	createShellRouteHydrationGuard,
} from "~/lib/shell-navigation-queue";
import {
	entityUrlSplat,
	entityRoutePath,
	findLixEntity,
	parseEntityUrlSplat,
	type EntityKind,
} from "~/lib/entity-url";
import {
	Atelier,
	AtelierSkeleton,
	type AtelierEvent,
	type AtelierHandle,
	type AtelierProps,
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
	useMemo,
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
import { createAtelierDocumentLinks } from "~/lib/atelier-document-links";
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
import { PRODUCT_EVENTS } from "~/lib/telemetry-events";
import {
	appendRepositoryShareToken,
	canonicalPathFromLocation,
	stripInviteFromUrl,
} from "~/lib/repository-share-url";
import { isRepositoryShareToken } from "~/lib/repository-share-capability";
import { configureBrowserTelemetryRepository } from "~/browser-telemetry";
import {
	createBrowserFileOpenTraceController,
	type BrowserFileOpenTraceController,
} from "~/lib/browser-file-open-trace";
import {
	openRepositoryLixSession,
	openRepositoryRemoteLix,
	type RepositoryMigrationState,
	type RepositoryLixSession,
} from "~/lib/repository-lix-session";
import { buildRepositoryReproduction } from "~/lib/repository-reproduction";
import {
	formatRepositoryOpenError,
	isRepositoryStorageInUse,
} from "~/lib/repository-open-error";
import { RepositoryOpenFailure } from "./repository-open-failure";
import { ReplicaRecovery } from "./replica-recovery";
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

type RepositoryAtelierHandle = AtelierHandle;

/** The chrome we show while an instance opens: Atelier's own, plus a label. */
type RepositoryShellSkeletonProps = Pick<
	AtelierProps,
	"slots" | "topBarProps"
> & { readonly children?: React.ReactNode };

function RepositoryShellSkeleton({
	children,
	...props
}: RepositoryShellSkeletonProps) {
	return (
		<div className="relative h-full">
			<AtelierSkeleton {...props} />
			<div className="pointer-events-none absolute inset-0 grid place-content-center">
				{children}
			</div>
		</div>
	);
}

const RepositoryAtelierContext = createContext<RepositoryAtelierHandle | null>(
	null,
);
const RepositoryFileOpenTraceContext =
	createContext<BrowserFileOpenTraceController | null>(null);
const RepositoryDefaultBranchContext = createContext<string | null>(null);
const RepositoryRouteLifecycleContext = createContext<
	(() => AbortController) | null
>(null);
const RepositoryRouteSyncContext = createContext<(() => void) | null>(null);
const RepositoryShellNavigationContext = createContext<
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
		accountId,
		client,
		getAccessToken: getSessionAccessToken,
		isLoaded: isAuthLoaded,
		refreshSession,
		signInWithGoogle,
		user,
	} = useAuth();
	// Supabase may replace the Session/User objects when a background tab resumes.
	// Keep the open Lix session keyed to identity so token refreshes do not reopen it.
	// `canEdit` is the protocol-principal split: members handshake as their
	// canonical account; public readers handshake as Anonymous
	// (`public:${repositoryId}`), including signed-in non-members whose JWT
	// is stripped by the worker before lix-server. Mixing those on one
	// session id is ACCOUNT_MISMATCH 403, not SESSION_GONE 410.
	const atelierAccountId = isDemoModeEnabled
		? DEMO_AUTH_TOKEN
		: canEdit
			? accountId
			: `public:${repositoryId}`;
	const navigate = useNavigate();
	const routeLocation = useRouterState({
		select: (state) => state.location,
	});
	const pathname = routeLocation.pathname;
	const routeParams = useParams({ strict: false });
	const routeSplat = "_splat" in routeParams ? routeParams._splat : undefined;
	const repositoryRootPath = `/@${namespace}/${repositorySlug}`;
	const routeChildKind: "file" | "folder" | "team" | "settings" | "sql" | null =
		pathname.startsWith(`${repositoryRootPath}/file/`)
			? "file"
			: pathname.startsWith(`${repositoryRootPath}/folder/`)
				? "folder"
				: pathname === `${repositoryRootPath}/team`
					? "team"
					: pathname === `${repositoryRootPath}/settings`
						? "settings"
						: pathname === `${repositoryRootPath}/sql`
							? "sql"
							: null;
	const routeFilePath = routeChildKind === "file" ? routeSplat : undefined;
	const routeFileId = parseEntityUrlSplat(routeFilePath)?.id;
	const fileOpenTrace = useMemo(
		() => createBrowserFileOpenTraceController(repositoryId, "partial_replica"),
		[repositoryId],
	);
	const documentName = activeDocumentName({
		pathname,
		routeFilePath,
		repositoryName,
	});
	const isReadOnly = !canEdit;
	const [instance, setInstance] = useState<RepositoryAtelierHandle | null>(
		null,
	);
	const [shellProps, setShellProps] = useState<AtelierProps | null>(null);
	const [branchSession, setBranchSession] =
		useState<RepositoryBranchSession | null>(null);
	const [repositoryDefaultBranchId, setRepositoryDefaultBranchId] = useState<
		string | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [storageBusy, setStorageBusy] = useState(false);
	const [openAttempt, setOpenAttempt] = useState(0);
	const [migration, setMigration] = useState<RepositoryMigrationState | null>(
		null,
	);
	const activeLixRef = useRef<RepositoryLixSession | null>(null);
	const pathnameRef = useRef(pathname);
	const routeChildRef = useRef<{
		kind: "file" | "folder" | "team" | "settings" | "sql" | null;
		splat: string | undefined;
	}>({ kind: routeChildKind, splat: routeSplat });
	const branchIdRef = useRef(branchId);
	const routeBranchSwitchRef = useRef(0);
	const suppressBranchNavigationRef = useRef(false);
	const eventHandlerRef = useRef<(event: AtelierEvent) => void>(
		() => undefined,
	);
	const atelierTelemetryHandlerRef = useRef<
		ReturnType<typeof createAtelierTelemetryHandler> | undefined
	>(undefined);
	useLayoutEffect(() => {
		pathnameRef.current = pathname;
	}, [pathname]);
	useLayoutEffect(() => {
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
						accountId: accountId ?? "demo-account",
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
						removeMember: (memberAccountId) => {
							const state = demoTeamState();
							state.members = state.members.filter(
								(member) =>
									member.accountId !== memberAccountId || member.isSelf,
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
								accountId: row.account_id,
								name: row.name,
								email: row.email,
								avatarUrl: row.avatar_url,
								role: row.role,
								isSelf: row.account_id === accountId,
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
						removeMember: async (memberAccountId: string) => {
							const { error } = await client.rpc("remove_lix_member", {
								p_lix_id: repositoryId,
								p_account_id: memberAccountId,
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
		removeMember: (memberAccountId) =>
			requireTeamApi(teamApiRef.current).removeMember(memberAccountId),
	});

	// Same rebuilt-per-render / stable-facade split for the Settings tab.
	const settingsApiRef = useRef<RepositorySettingsApi | null>(null);
	useEffect(() => {
		settingsApiRef.current =
			!canEdit || isDemoModeEnabled || !client
				? null
				: {
						info: () => ({
							repositoryId,
							namespaceHandle: namespace,
							repositorySlug,
							repositoryName: activeRepository?.name ?? repositoryName,
							isAdmin: Boolean(isRepositoryAdmin),
							visibility: activeRepository?.visibility ?? "private",
							currentAccountId: accountId,
						}),
						rename: (name) => renameRepository(repositoryId, name),
						listDirectMembers: async () => {
							const { data, error } = await client.rpc("list_lix_members", {
								p_lix_id: repositoryId,
							});
							if (error) throw new Error(error.message);
							return (data ?? []).map((row) => ({
								accountId: row.account_id,
								name: row.name,
								email: row.email,
								avatarUrl: row.avatar_url,
								role: row.role,
							}));
						},
						removeDirectMember: async (memberAccountId) => {
							const { error } = await client.rpc("remove_lix_member", {
								p_lix_id: repositoryId,
								p_account_id: memberAccountId,
							});
							if (error) throw new Error(error.message);
						},
						setMemberRole: async (memberAccountId, role) => {
							const { error } = await client.rpc("set_lix_member_role", {
								p_lix_id: repositoryId,
								p_account_id: memberAccountId,
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
							// The public profile serves activity from a day-long cache;
							// a visibility change should show up there right away.
							void (async () => {
								const accessToken = await getSessionAccessToken();
								if (!accessToken) return;
								await fetch(
									`/profile/${encodeURIComponent(namespaceId)}/activity/refresh`,
									{
										method: "POST",
										headers: { Authorization: `Bearer ${accessToken}` },
									},
								);
							})().catch(() => undefined);
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
				repositoryId,
				namespaceHandle: namespace,
				repositorySlug,
				repositoryName,
				isAdmin: false,
				visibility: "private",
				currentAccountId: null,
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
			className="inline-flex h-7 cursor-default items-center rounded-[7px] px-2.5 text-xs font-semibold text-fg-subtle/70"
		>
			Share
		</span>
	);
	// Sharing is available for the whole repository as well as individual files;
	// the current browser URL is captured when the dialog is opened.
	const resolveRouteResourcePath = async () => {
		if (routeChildKind !== "file" && routeChildKind !== "folder") return "/";
		const entity = parseEntityUrlSplat(routeSplat);
		const lix = activeLixRef.current?.lix;
		if (!entity || !lix) throw new Error("Item is unavailable.");
		const resource = await findLixEntity(
			lix,
			routeChildKind === "file" ? "file" : "directory",
			{ id: entity.id },
		);
		if (!resource) throw new Error("Item no longer exists.");
		return resource.path;
	};
	const repositoryHeaderActions = canEdit ? (
		client ? (
			<RepositoryShareControl
				loadReadAccess={async () => {
					const resourcePath =
						routeChildKind === "file" || routeChildKind === "folder"
							? await resolveRouteResourcePath()
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
					if (routeChildKind !== "file" && routeChildKind !== "folder") {
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
					if (routeChildKind === "file" || routeChildKind === "folder") {
						const path = await resolveRouteResourcePath();
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
					if (routeChildKind === "file" || routeChildKind === "folder") {
						const { error } = await client.rpc("unpublish_lix_resource", {
							p_lix_id: repositoryId,
							p_path: await resolveRouteResourcePath(),
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
						: routeChildKind === "folder"
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
			{user ? <AccountMenu /> : null}
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
						routeChild.kind === "folder"
							? "/@{$namespace}/$repository/folder/$"
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
	// applied so a restored session cannot clobber a deep link. Explicit user
	// tab selection cancels that pending route and takes precedence.
	const routeLifecycle = useRef(createRepositoryRouteLifecycle());
	const beginRouteNavigation = useCallback(
		() => routeLifecycle.current.begin(),
		[],
	);
	useEffect(() => {
		const lifecycle = routeLifecycle.current;
		return () => lifecycle.cancel();
	}, []);
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
	// Shell-issued routes skip hydration: a newer tab may already be active.
	const shellNavigationRef = useRef<string | null>(null);
	const [reviewFocusActive, setReviewFocusActive] = useState(false);
	const shellHydrationGuard = useRef(createShellRouteHydrationGuard());
	const routeVisit = JSON.stringify([
		routeLocation.state.__TSR_key,
		routeLocation.href,
	]);
	const shellRouteVisitRef = useRef({ instance, routeVisit });
	useLayoutEffect(() => {
		const previous = shellRouteVisitRef.current;
		if (previous.instance !== instance || previous.routeVisit !== routeVisit) {
			shellHydrationGuard.current.reset();
		}
		shellRouteVisitRef.current = { instance, routeVisit };
	}, [instance, routeVisit]);
	const consumeShellNavigation = useCallback((navigationKey: string) => {
		const visit = shellRouteVisitRef.current;
		return shellHydrationGuard.current.isShellIssued(
			visit.instance,
			JSON.stringify([visit.routeVisit, navigationKey]),
			() => {
				const matches = shellNavigationRef.current === navigationKey;
				shellNavigationRef.current = null;
				return matches;
			},
		);
	}, []);
	useEffect(() => {
		let navigationRevision = 0;
		const navigationQueue = createShellNavigationQueue();
		eventHandlerRef.current = (event) => {
			if (event.type === "document_open_attempted")
				fileOpenTrace.documentAttempted(
					event.filePath,
					event.fileId,
					event.supported,
					event.navigationCause,
				);
			else if (event.type === "document_loaded")
				fileOpenTrace.documentLoaded(event.filePath, event.fileId);
			atelierTelemetryHandlerRef.current?.(event);
			if (event.type === "diff_session_changed") {
				// Review focus: chrome outside the changes (the brand and
				// repository selector) recedes with the rest of the page.
				setReviewFocusActive(event.active && event.changedFileCount > 0);
				return;
			}
			if (event.type === "main_view_navigation_requested") {
				routeLifecycle.current.cancel();
				routeSyncedRef.current = true;
			} else if (event.type !== "main_view_activated") return;
			const revision = ++navigationRevision;
			if (!routeSyncedRef.current) return;
			// Keep a pending shell marker until its own route commit consumes it.
			const activeBranchId = activeLixRef.current?.activeBranchSnapshot();
			const defaultBranchId = activeLixRef.current?.defaultBranchSnapshot();
			const search =
				activeBranchId && defaultBranchId
					? atelierBranchSearch(activeBranchId, defaultBranchId)
					: {};
			const navigateEntity = async (kind: EntityKind, path: string) => {
				const session = activeLixRef.current;
				if (!session) return;
				try {
					const startingPath = await navigationQueue.settle(
						() => pathnameRef.current,
					);
					if (
						startingPath === null ||
						revision !== navigationRevision ||
						session !== activeLixRef.current ||
						activeBranchId !== session.activeBranchSnapshot()
					)
						return;
					const entity = await findLixEntity(session.lix, kind, { path });
					if (
						!entity ||
						revision !== navigationRevision ||
						session !== activeLixRef.current ||
						startingPath !== pathnameRef.current ||
						activeBranchId !== session.activeBranchSnapshot()
					)
						return;
					const current = routeChildRef.current;
					if (
						current.kind === (kind === "file" ? "file" : "folder") &&
						parseEntityUrlSplat(current.splat)?.id === entity.id
					)
						return;
					shellNavigationRef.current = `${kind}:${entity.id}`;
					await navigationQueue.navigate(
						entityRoutePath(
							namespace,
							repositorySlug,
							kind,
							entity.id,
							entity.path,
						),
						() =>
							navigate({
								to:
									kind === "file"
										? "/@{$namespace}/$repository/file/$"
										: "/@{$namespace}/$repository/folder/$",
								params: {
									namespace,
									repository: repositorySlug,
									_splat: entityUrlSplat(entity.id, entity.path),
								},
								search,
							}),
					);
				} catch (error) {
					console.error("Unable to resolve item URL", error);
				}
			};
			if (event.viewKind === LIXRAY_HOME_EXTENSION_ID) {
				// Home is the primary Files surface (flow A): drilled into a
				// folder it claims the /folder URL, at the root it claims the
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
					void navigateEntity("directory", dirPath);
					return;
				}
				const targetPath = `/@${namespace}/${repositorySlug}`;
				if (pathnameRef.current === targetPath) return;
				shellNavigationRef.current = "view:home";
				void navigationQueue
					.navigate(targetPath, () =>
						navigate({
							to: "/@{$namespace}/$repository",
							params: { namespace, repository: repositorySlug },
							search,
						}),
					)
					.catch((error: unknown) =>
						console.error("Unable to navigate shell", error),
					);
				return;
			}
			if (event.viewKind === LIXRAY_PEOPLE_EXTENSION_ID) {
				const targetPath = `/@${namespace}/${repositorySlug}/team`;
				if (pathnameRef.current === targetPath) return;
				shellNavigationRef.current = "view:team";
				void navigationQueue
					.navigate(targetPath, () =>
						navigate({
							to: "/@{$namespace}/$repository/team",
							params: { namespace, repository: repositorySlug },
							search,
						}),
					)
					.catch((error: unknown) =>
						console.error("Unable to navigate shell", error),
					);
				return;
			}
			if (event.viewKind === LIXRAY_SETTINGS_EXTENSION_ID) {
				const targetPath = `/@${namespace}/${repositorySlug}/settings`;
				if (pathnameRef.current === targetPath) return;
				shellNavigationRef.current = "view:settings";
				void navigationQueue
					.navigate(targetPath, () =>
						navigate({
							to: "/@{$namespace}/$repository/settings",
							params: { namespace, repository: repositorySlug },
							search,
						}),
					)
					.catch((error: unknown) =>
						console.error("Unable to navigate shell", error),
					);
				return;
			}
			if (event.viewKind === "sql_explorer") {
				const targetPath = `/@${namespace}/${repositorySlug}/sql`;
				if (pathnameRef.current === targetPath) return;
				shellNavigationRef.current = "view:sql";
				void navigationQueue
					.navigate(targetPath, () =>
						navigate({
							to: "/@{$namespace}/$repository/sql",
							params: { namespace, repository: repositorySlug },
							search,
						}),
					)
					.catch((error: unknown) =>
						console.error("Unable to navigate shell", error),
					);
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
				void navigateEntity("directory", dirPath);
				return;
			}
			if (event.filePath) void navigateEntity("file", event.filePath);
		};
		return () => {
			navigationRevision++;
		};
	}, [fileOpenTrace, namespace, navigate, repositorySlug]);

	useEffect(() => {
		configureBrowserTelemetryRepository(repositoryId, getAccessToken);
		if (routeFileId) fileOpenTrace.ensureRoute(routeFileId);
		else fileOpenTrace.cancel();
	}, [fileOpenTrace, getAccessToken, repositoryId, routeFileId]);
	useEffect(() => () => fileOpenTrace.cancel(), [fileOpenTrace]);

	useEffect(() => {
		let disposed = false;
		let activeLix: RepositoryLixSession | null = null;
		let debugRemoteLix: ReturnType<typeof openRepositoryRemoteLix> | null =
			null;
		const openController = new AbortController();
		resetRepositoryOpenPerformance();
		setShellProps(null);
		setInstance(null);
		setBranchSession(null);
		setRepositoryDefaultBranchId(null);
		setError(null);
		setStorageBusy(false);
		setMigration(null);
		routeSyncedRef.current = false;

		if (!atelierAccountId) {
			setError("Unable to identify the current Atelier account.");
			return;
		}
		const openingBranchId = branchIdRef.current ?? null;
		const openingFileId =
			routeChildRef.current.kind === "file"
				? parseEntityUrlSplat(routeChildRef.current.splat)?.id
				: undefined;
		if (openingFileId) fileOpenTrace.ensureRepositoryAttempt(openingFileId);
		void fileOpenTrace.run(() =>
			openRepositoryLixSession({
				namespace,
				repositorySlug: repositorySlug,
				repositoryId: repositoryId,
				getAccessToken,
				refreshAccessToken,
				allowAnonymous: isReadOnly,
				publicPath: isReadOnly ? publicPath : undefined,
				initialBranchId: openingBranchId,
				authIdentity: atelierAccountId,
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
					if (import.meta.env.DEV) {
						// Dev-only escape hatch: lets the console (and agents driving
						// the browser) run SQL against the open repository directly.
						(window as { __lix?: unknown }).__lix = session.lix;
						console.info(
							"[lixray] window.__lix exposes this repository for debugging: " +
								'await __lix.execute("SELECT …") — read row columns with ' +
								'.get("col"). Prefer this over driving the SQL Explorer UI.',
						);
					}
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
					const getDebugRemoteLix = async () => {
						debugRemoteLix ??= openRepositoryRemoteLix({
							namespace,
							repositorySlug,
							repositoryId,
							getAccessToken,
							refreshAccessToken,
							allowAnonymous: isReadOnly,
							publicPath: isReadOnly ? publicPath : undefined,
							authIdentity: atelierAccountId,
						});
						const remote = await debugRemoteLix;
						const activeBranchId = session.activeBranchSnapshot();
						if ((await remote.activeBranchId()) !== activeBranchId) {
							await remote.switchBranch({ branchId: activeBranchId });
						}
						return remote;
					};
					const getDebugRemoteSnapshot = async () =>
						new Response((await getDebugRemoteLix()).exportSnapshot(), {
							headers: {
								"Content-Type": "application/vnd.lix.snapshot",
							},
						}).blob();
					const atelierProps: AtelierProps = {
						lix: session.lix,
						scopeDocumentLix: (path, fileId, lix) =>
							fileOpenTrace.scopeLix(path, fileId, lix),
						onError: (error) =>
							captureExceptionTelemetry(error, {
								operation: "atelier_view_render",
								lix_id: repositoryId,
								namespace_id: namespace,
							}),
						readOnly: isReadOnly,
						// Links to this repository's own file URLs behave like
						// relative links; mentions write the permanent form.
						documentLinks: createAtelierDocumentLinks({
							origin: window.location.origin,
							namespace,
							repository: repositorySlug,
							activeBranchId: () => session.activeBranchSnapshot(),
							defaultBranchId: () => session.defaultBranchSnapshot(),
						}),
						debug: {
							remoteLix: getDebugRemoteLix,
							remoteSnapshot: getDebugRemoteSnapshot,
							snapshotName: `${namespace}-${repositorySlug}`,
							createReproduction: ({ query, diffCsv }) =>
								buildRepositoryReproduction({
									localLix: session.lix,
									selectedBranchIdAtSnapshotStart:
										session.activeBranchSnapshot(),
									remoteSnapshot: getDebugRemoteSnapshot,
									query,
									diffCsv,
								}),
						},
						branchSession: repositoryBranchSession,
						extensions: createLixrayRepositoryExtensions(
							{
								lixId: repositoryId,
								namespace,
								lixSlug: repositorySlug,
								lixName: repositoryName,
							},
							async () => {
								if (!client || !canEdit || !atelierAccountId) return false;
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
							canEdit && !isDemoModeEnabled && client
								? stableSettingsApiRef.current
								: null,
							repositoryVisibility,
							(lix) => fileOpenTrace.scopeRepositoryLix(lix),
						),
						onReady: setInstance,
						mainArea: {
							home: { extensionId: LIXRAY_HOME_EXTENSION_ID },
						},
						sessionStateStore: createRepositorySessionStateStore({
							accountId: atelierAccountId,
							repositoryId,
						}),
						preferencesStore: createRepositoryPreferencesStore({
							accountId: atelierAccountId,
							repositoryId,
						}),
						reviewStatusStore: createRepositoryReviewStatusStore({
							accountId: atelierAccountId,
							repositoryId,
						}),
						onEvent: (event) => eventHandlerRef.current(event),
					};
					markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.atelierReady);
					setShellProps(atelierProps);
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
						const failedFileId =
							routeChildRef.current.kind === "file"
								? parseEntityUrlSplat(routeChildRef.current.splat)?.id
								: undefined;
						if (failedFileId) fileOpenTrace.failed(failedFileId);
						setMigration(null);
						captureExceptionTelemetry(caught, {
							operation: "repository_open",
							lix_id: repositoryId,
							namespace_id: namespace,
						});
						setStorageBusy(isRepositoryStorageInUse(caught));
						void reportRepositoryOpenFailure(caught, {
							repositoryId,
							release: import.meta.env.VITE_LIXRAY_RELEASE_ID ?? "unknown",
							getAccessToken,
						});
						setError(formatRepositoryOpenError(caught));
					}
				}),
		);

		return () => {
			disposed = true;
			openController.abort();
			const session = activeLix;
			activeLix = null;
			activeLixRef.current = null;
			const remote = debugRemoteLix;
			debugRemoteLix = null;
			if (remote) void remote.then((lix) => lix.close()).catch(() => undefined);
			if (session) void session.close();
		};
	}, [
		openAttempt,
		client,
		atelierAccountId,
		canEdit,
		isReadOnly,
		getAccessToken,
		fileOpenTrace,
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
		if (consumeShellNavigation("view:home")) {
			markRouteSynced();
			return;
		}
		// The state reset matters as much as the activation: Home may be
		// drilled into a folder (flow A), and the root URL means the root
		// listing.
		const controller = beginRouteNavigation();
		void instance.views
			.open(LIXRAY_HOME_EXTENSION_ID, {
				state: lixrayHomeDirState("/"),
				signal: controller.signal,
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted)
					console.error("Unable to activate the repository home", error);
			})
			.finally(() => {
				if (!controller.signal.aborted) markRouteSynced();
			});
		return () => controller.abort();
	}, [
		instance,
		beginRouteNavigation,
		markRouteSynced,
		consumeShellNavigation,
		namespace,
		pathname,
		repositorySlug,
	]);

	const navbarBrand = (
		<RepositoryNavbarBrand
			dimmed={reviewFocusActive}
			signedIn={Boolean(user)}
			namespaceId={namespaceId}
			namespaceHandle={namespace}
			repositoryName={repositoryName}
			repositorySlug={repositorySlug}
		/>
	);
	return (
		<div
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg"
			aria-busy={!shellProps && !error}
		>
			{shellProps ? (
				<RepositoryDefaultBranchContext.Provider
					value={repositoryDefaultBranchId}
				>
					<RepositoryBranchSessionContext.Provider value={branchSession}>
						<RepositoryRouteLifecycleContext.Provider
							value={beginRouteNavigation}
						>
							<RepositoryRouteSyncContext.Provider value={markRouteSynced}>
								<RepositoryShellNavigationContext.Provider
									value={consumeShellNavigation}
								>
									<RepositoryAtelierContext.Provider value={instance}>
										<RepositoryFileOpenTraceContext.Provider
											value={fileOpenTrace}
										>
											<Atelier
												{...shellProps}
												topBarProps={REPOSITORY_TOP_BAR_PROPS}
												slots={{
													navbarBrand,
													navbarEnd: headerActions,
												}}
											/>
											<Outlet />
											{shellProps.lix ? (
												<ReplicaRecovery lix={shellProps.lix} />
											) : null}
										</RepositoryFileOpenTraceContext.Provider>
									</RepositoryAtelierContext.Provider>
								</RepositoryShellNavigationContext.Provider>
							</RepositoryRouteSyncContext.Provider>
						</RepositoryRouteLifecycleContext.Provider>
					</RepositoryBranchSessionContext.Provider>
				</RepositoryDefaultBranchContext.Provider>
			) : null}
			{!shellProps && !error && migration ? (
				<RepositoryUpgradeProgress phase={migration.phase} />
			) : null}
			{!shellProps && !error && !migration ? (
				<RepositoryShellSkeleton
					topBarProps={REPOSITORY_TOP_BAR_PROPS}
					slots={{ navbarBrand, navbarEnd: headerActions }}
				>
					<DelayedOpeningLabel />
				</RepositoryShellSkeleton>
			) : null}
			{error ? (
				<RepositoryOpenFailure
					message={error}
					storageBusy={storageBusy}
					onRetry={() => {
						setError(null);
						setStorageBusy(false);
						setOpenAttempt((attempt) => attempt + 1);
					}}
				/>
			) : null}
		</div>
	);
}

export function useRepositoryAtelierInstance(): RepositoryAtelierHandle | null {
	return useContext(RepositoryAtelierContext);
}

export function useRepositoryFileOpenTrace(): BrowserFileOpenTraceController | null {
	return useContext(RepositoryFileOpenTraceContext);
}

export function useRepositoryDefaultBranchId(): string | null {
	return useContext(RepositoryDefaultBranchContext);
}

export function useBeginRepositoryRouteNavigation(): () => AbortController {
	const begin = useContext(RepositoryRouteLifecycleContext);
	return begin ?? (() => new AbortController());
}

/**
 * Child routes call this after applying their URL to the Atelier tabs;
 * until then, tab-activation events do not navigate (deep links win).
 */
export function useMarkRepositoryRouteSynced(): () => void {
	const markRouteSynced = useContext(RepositoryRouteSyncContext);
	return markRouteSynced ?? (() => undefined);
}

/** Consume a shell-issued route marker so URL hydration cannot steal tab focus. */
export function useConsumeShellEntityNavigation(): (
	entityKey: string,
) => boolean {
	const consume = useContext(RepositoryShellNavigationContext);
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
				captureTelemetry(PRODUCT_EVENTS.resourcePublished, {
					resource_kind: publicationLabel,
				});
			}}
			unpublishReadLink={async () => {
				await unpublishReadLink();
				setReadAccess({ status: "private", canPublish: true });
				captureTelemetry(PRODUCT_EVENTS.resourceUnpublished, {
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
				captureTelemetry(PRODUCT_EVENTS.shareLinkCopied, {
					share_mode: "public",
				});
			}}
			trigger={
				<Button
					type="button"
					size="xs"
					variant="ghost"
					className="h-7 rounded-[7px] px-2.5 text-xs font-semibold text-fg-muted hover:bg-bg-hover-strong hover:text-fg"
				>
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
	const encodedName = parseEntityUrlSplat(encodedPath)?.name;
	if (!encodedName) return repositoryName;
	try {
		return decodeURIComponent(encodedName);
	} catch {
		return encodedName;
	}
}

/** Keeps fast opens silent; the label appears only when opening is slow. */
function DelayedOpeningLabel() {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setVisible(true), 500);
		return () => window.clearTimeout(timer);
	}, []);
	return visible ? <>Connecting to repository…</> : null;
}

const REPOSITORY_TOP_BAR_PROPS = {
	"data-app-titlebar": true,
	className: "border-b border-border-subtle bg-bg",
} as const;

function RepositoryNavbarBrand({
	signedIn,
	namespaceId,
	namespaceHandle,
	repositoryName,
	repositorySlug,
	dimmed = false,
}: {
	signedIn: boolean;
	namespaceId: string;
	namespaceHandle: string;
	repositoryName: string;
	repositorySlug: string;
	/** Review focus: the brand and selector recede; hover restores them. */
	dimmed?: boolean;
}) {
	return (
		<span
			className={`flex min-w-0 items-center gap-2 transition-opacity${
				dimmed ? " opacity-[0.35] hover:opacity-100" : ""
			}`}
		>
			<a
				href={signedIn ? "/home" : "/"}
				aria-label="LixRay home"
				// -ml-1.5 pulls the mark from the top bar's 14px content line to
				// x=8 — the same x as the profile and home headers' mark. The
				// sidebar's 14px icon column centers under the 24px mark.
				className="-ml-1.5 inline-flex shrink-0 items-center rounded-[5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<img className="size-6" src="/lixray-mark.svg" alt="" />
			</a>
			<RepositoryPicker
				namespaceId={namespaceId}
				namespaceHandle={namespaceHandle}
				repositoryName={repositoryName}
				repositorySlug={repositorySlug}
			/>
		</span>
	);
}

/**
 * Atelier chrome with an empty panel, shown wherever a repository is still
 * resolving or opening so navigation never flashes a bespoke splash screen.
 */
export function RepositoryOpeningSkeleton({
	signedIn,
	namespaceHandle,
	repositorySlug,
	namespaceId = "",
	repositoryName,
}: {
	signedIn: boolean;
	namespaceHandle: string;
	repositorySlug: string;
	/** Unknown while the route is still resolving; the picker falls back to a label. */
	namespaceId?: string;
	repositoryName?: string;
}) {
	return (
		<div
			className="fixed inset-0 h-full w-full overflow-hidden bg-bg"
			aria-busy
		>
			<RepositoryShellSkeleton
				topBarProps={REPOSITORY_TOP_BAR_PROPS}
				slots={{
					navbarBrand: (
						<RepositoryNavbarBrand
							signedIn={signedIn}
							namespaceId={namespaceId}
							namespaceHandle={namespaceHandle}
							repositoryName={repositoryName ?? repositorySlug}
							repositorySlug={repositorySlug}
						/>
					),
				}}
			>
				<DelayedOpeningLabel />
			</RepositoryShellSkeleton>
		</div>
	);
}
