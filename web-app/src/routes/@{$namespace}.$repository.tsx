import { repositoryHead } from "~/lib/page-head";
import {
	createFileRoute,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
import {
	PublishedResourceView,
	type PublishedResource,
} from "~/components/published-resource-view";
import { RepositoryAtelier } from "~/components/repository-atelier";
import {
	RepositoryAccessPending,
	RepositoryAccessScreen,
} from "~/components/repository-access-screen";
import { useRepository } from "~/components/repository-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";
import {
	acceptTeamInviteForRepository,
	resolvePublicRepositoryByRoute,
	resolveRepositoryShareToken,
	TeamInviteAccessConfirmationError,
	type PublicRepositoryRoute,
} from "~/lib/public-repository";
import {
	clearRepositoryShareCapability,
	isRepositoryShareToken,
	peekRepositoryShareCapability,
	peekRepositoryShareJoinIntent,
	requestRepositoryShareJoin,
	stageRepositoryShareCapability,
	takeRepositoryShareCapability,
	takeRepositoryShareJoinError,
	takeRepositoryShareJoinIntent,
	takeRepositoryShareJoined,
	type PendingRepositoryShareCapability,
} from "~/lib/repository-share-capability";
import {
	isTeamInviteToken,
	peekTeamInvite,
	stageTeamInvite,
	stagedTeamInviteForRoute,
	takeTeamInvite,
} from "~/lib/team-invite";
import { canonicalPathFromLocation } from "~/lib/repository-share-url";
import { findRepositoryByRoute, normalizeDirPath } from "~/lib/repository-url";

interface RepositorySearch {
	dir?: string;
	branch?: string;
	invite?: string;
}

export const Route = createFileRoute("/@{$namespace}/$repository")({
	head: ({ params }) => repositoryHead(params),
	ssr: false,
	pendingComponent: RepositoryAccessPending,
	validateSearch: (search: Record<string, unknown>): RepositorySearch => {
		const dir = normalizeDirPath(search.dir);
		const branch =
			typeof search.branch === "string" && search.branch.trim().length > 0
				? search.branch.trim()
				: undefined;
		const invite = isRepositoryShareToken(search.invite)
			? search.invite
			: undefined;
		return {
			...(dir === "/" ? {} : { dir }),
			...(branch ? { branch } : {}),
			...(invite ? { invite } : {}),
		};
	},
	component: RepositoryRoutePage,
});

function RepositoryRoutePage() {
	const { namespace, repository: repositorySlug } = Route.useParams();
	const { branch, invite } = Route.useSearch();
	const {
		client: authClient,
		isLoaded: authIsLoaded,
		signInWithGoogle,
		user: authUser,
	} = useAuth();
	const repositoryState = useRepository();
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const searchStr = useRouterState({
		select: (state) => state.location.searchStr,
	});
	const publishedResource = publishedResourceFromRoute(
		pathname,
		namespace,
		repositorySlug,
	);
	const publicPath = publishedResource?.path;
	const demoResolved = useMemo(
		() =>
			findRepositoryByRoute(
				repositoryState.organizations,
				namespace,
				repositorySlug,
			),
		[namespace, repositorySlug, repositoryState.organizations],
	);
	const demoCanEdit = isDemoModeEnabled && demoResolved !== null;
	const [resolved, setResolved] = useState<
		PublicRepositoryRoute | null | undefined
	>(undefined);
	const [resolveError, setResolveError] = useState<string | null>(null);
	const [shareCapability, setShareCapability] =
		useState<PendingRepositoryShareCapability | null>(null);
	const [joining, setJoining] = useState(false);
	const [accessRevision, setAccessRevision] = useState(0);
	const [settledInviteKey, setSettledInviteKey] = useState<string | null>(null);
	const [stagedTeamInvite, setStagedTeamInvite] = useState(peekTeamInvite);
	const [failedInviteKey, setFailedInviteKey] = useState<string | null>(null);
	const automaticJoinAttempt = useRef<string | null>(null);
	// File and tab navigation changes `publicPath`, but a public repository or
	// editable workspace has already crossed the repository authorization
	// boundary. Only anonymous private-resource views remain path-scoped.
	const routeAccessPath =
		isDemoModeEnabled ||
		(resolved && (resolved.canEdit || resolved.visibility === "public"))
			? undefined
			: publicPath;
	const resolvedRepositoryId = resolved?.repositoryId;
	const urlTeamInvite = invite && isTeamInviteToken(invite) ? invite : null;
	const pendingTeamInvite =
		urlTeamInvite ??
		stagedTeamInviteForRoute(stagedTeamInvite, namespace, repositorySlug);
	const inviteResolutionKey = pendingTeamInvite
		? `team:${namespace}/${repositorySlug}:${pendingTeamInvite}`
		: resolvedRepositoryId && invite
			? `${resolvedRepositoryId}:${invite}`
			: null;
	const shouldWaitForInviteResolution =
		!isDemoModeEnabled &&
		inviteResolutionKey !== null &&
		settledInviteKey !== inviteResolutionKey;

	// Public route resolution is intentionally independent of the repository
	// directory. A reader may have no organization membership at all.
	useEffect(() => {
		let disposed = false;
		setResolveError(null);
		setResolved((current) => {
			const stillSameRepository =
				current?.organizationHandle === namespace &&
				current.repositorySlug === repositorySlug;
			// Refreshing access for another path in this repository must not tear
			// down Atelier. A changed repository identity still gets the loading UI.
			return stillSameRepository ? current : undefined;
		});

		if (isDemoModeEnabled) {
			if (!authIsLoaded) return;
			setResolved(
				demoResolved
					? {
							organizationId: demoResolved.organization.id,
							organizationName: demoResolved.organization.name,
							organizationHandle: demoResolved.organization.handle,
							repositoryId: demoResolved.repository.id,
							repositoryName: demoResolved.repository.name,
							repositorySlug: demoResolved.repository.slug,
							canEdit: demoCanEdit,
							role: demoCanEdit ? "admin" : null,
							visibility: "public",
							pathPublic: true,
						}
					: null,
			);
			return;
		}
		if (!authIsLoaded || !authClient) return;

		const repositoryCapabilityToken =
			invite && !isTeamInviteToken(invite)
				? invite
				: peekRepositoryShareCapability()?.token;
		const resolution = repositoryCapabilityToken
			? resolveRepositoryShareToken(authClient, repositoryCapabilityToken).then(
					(candidate) => {
						if (
							!candidate ||
							candidate.organizationHandle !== namespace ||
							candidate.repositorySlug !== repositorySlug
						) {
							return null;
						}
						return {
							organizationId: candidate.organizationId,
							organizationName: candidate.organizationName,
							organizationHandle: candidate.organizationHandle,
							repositoryId: candidate.repositoryId,
							repositoryName: candidate.repositoryName,
							repositorySlug: candidate.repositorySlug,
							canEdit: candidate.role !== null,
							role: candidate.role,
							visibility: candidate.visibility,
							pathPublic: candidate.pathPublic,
						} satisfies PublicRepositoryRoute;
					},
				)
			: resolvePublicRepositoryByRoute(
					authClient,
					namespace,
					repositorySlug,
					routeAccessPath,
				);

		void resolution
			.then((nextResolved) => {
				if (!disposed) setResolved(nextResolved);
			})
			.catch((caught: unknown) => {
				if (disposed) return;
				setResolveError(
					caught instanceof Error
						? caught.message
						: "Unable to open repository.",
				);
				setResolved(null);
			});

		return () => {
			disposed = true;
		};
	}, [
		accessRevision,
		authClient,
		authIsLoaded,
		authUser?.id,
		demoCanEdit,
		demoResolved,
		invite,
		namespace,
		routeAccessPath,
		repositorySlug,
	]);

	const cleanInviteFromAddressBar = useCallback(() => {
		void navigate({
			to: ".",
			search: (previous) => {
				const canonicalSearch = { ...(previous as RepositorySearch) };
				delete canonicalSearch.invite;
				return canonicalSearch;
			},
			hash: true,
			replace: true,
			resetScroll: false,
		});
	}, [navigate]);

	// A team invite (tm_…) joins the repository's namespace. Keep the Atelier
	// closed until the invite has been accepted and a fresh route lookup confirms
	// edit access. Otherwise the public route can mount a read-only Lix while the
	// membership update is still in flight.
	useEffect(() => {
		if (
			isDemoModeEnabled ||
			!authClient ||
			!pendingTeamInvite ||
			!authIsLoaded
		) {
			return;
		}
		const inviteKey = `team:${namespace}/${repositorySlug}:${pendingTeamInvite}`;
		if (settledInviteKey === inviteKey || failedInviteKey === inviteKey) return;
		let disposed = false;
		const settle = (clearPending: boolean) => {
			if (disposed) return;
			setSettledInviteKey(inviteKey);
			if (clearPending) {
				takeTeamInvite();
				setStagedTeamInvite(null);
			}
			if (urlTeamInvite) cleanInviteFromAddressBar();
		};
		if (!authUser) {
			const staged = {
				token: pendingTeamInvite,
				namespace,
				repositorySlug,
			} as const;
			stageTeamInvite(staged);
			setStagedTeamInvite(staged);
			const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
			window.location.replace(
				`/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
			);
			return;
		}
		void (async () => {
			try {
				const joined = await acceptTeamInviteForRepository(
					authClient,
					pendingTeamInvite,
					namespace,
					repositorySlug,
				);
				if (disposed) return;
				setResolved(joined.repository);
				toast.success(
					joined.joinedNamespaceName
						? `You joined ${joined.joinedNamespaceName} — every repository, edit access.`
						: "You joined the team.",
				);
				settle(true);
				void repositoryState.refresh({
					repositoryId: joined.repository.repositoryId,
				});
			} catch (caught) {
				if (!disposed) {
					if (caught instanceof TeamInviteAccessConfirmationError) {
						setFailedInviteKey(inviteKey);
						toast.error(caught.message);
					} else {
						toast.error("This invite link is invalid or was reset.");
						settle(true);
					}
				}
			}
		})();
		return () => {
			disposed = true;
		};
	}, [
		authClient,
		authIsLoaded,
		authUser,
		cleanInviteFromAddressBar,
		failedInviteKey,
		namespace,
		pendingTeamInvite,
		settledInviteKey,
		urlTeamInvite,
		repositorySlug,
		repositoryState,
	]);

	// A capability is resolved once, held only for this browser session, then
	// removed from router state and the address bar. Invalid/revoked links clean
	// to the same public read page instead of becoming a dead end.
	useEffect(() => {
		if (
			isDemoModeEnabled ||
			!resolvedRepositoryId ||
			!authClient ||
			!invite ||
			isTeamInviteToken(invite)
		)
			return;
		let disposed = false;
		void resolveRepositoryShareToken(authClient, invite)
			.then((candidate) => {
				if (disposed) return;
				if (
					candidate &&
					candidate.grantsEdit &&
					candidate.repositoryId === resolvedRepositoryId
				) {
					const capability = {
						token: invite,
						repositoryId: candidate.repositoryId,
						sharerName: candidate.sharedByName,
					};
					stageRepositoryShareCapability(capability);
					// Render token-derived UI only after the canonical URL has been
					// reached and the session-held capability is checked again.
					setShareCapability(null);
				} else {
					clearRepositoryShareCapability();
					setShareCapability(null);
				}
			})
			.catch(() => {
				if (disposed) return;
				clearRepositoryShareCapability();
				setShareCapability(null);
				toast.error("Unable to validate this share link.");
			})
			.finally(() => {
				if (!disposed) {
					setSettledInviteKey(`${resolvedRepositoryId}:${invite}`);
					cleanInviteFromAddressBar();
				}
			});
		return () => {
			disposed = true;
		};
	}, [authClient, cleanInviteFromAddressBar, invite, resolvedRepositoryId]);

	// Validation deliberately drops malformed tokens from router search. Clean a
	// raw malformed `invite` parameter too, so it cannot survive in history or
	// reappear on a later in-app navigation.
	useEffect(() => {
		if (resolved === undefined || invite || typeof window === "undefined") {
			return;
		}
		const rawInvite = new URLSearchParams(window.location.search).get("invite");
		if (!rawInvite || isRepositoryShareToken(rawInvite)) return;
		clearRepositoryShareCapability();
		setShareCapability(null);
		cleanInviteFromAddressBar();
	}, [cleanInviteFromAddressBar, invite, resolved]);

	// After canonicalization, re-check the session-held capability. This keeps a
	// revoked link on the plain public page even after its token left the URL.
	useEffect(() => {
		if (!resolved || invite) return;
		if (isDemoModeEnabled) {
			clearRepositoryShareCapability();
			setShareCapability(null);
			return;
		}
		if (!authClient) return;
		const staged = peekRepositoryShareCapability();
		if (
			!staged ||
			staged.repositoryId !== resolved.repositoryId ||
			resolved.canEdit
		) {
			if (resolved.canEdit) clearRepositoryShareCapability();
			setShareCapability(null);
			return;
		}

		let disposed = false;
		setShareCapability(null);
		void resolveRepositoryShareToken(authClient, staged.token)
			.then((candidate) => {
				if (disposed) return;
				if (
					!candidate ||
					!candidate.grantsEdit ||
					candidate.repositoryId !== resolved.repositoryId
				) {
					clearRepositoryShareCapability();
					setShareCapability(null);
					return;
				}
				const capability = {
					token: staged.token,
					repositoryId: candidate.repositoryId,
					sharerName: candidate.sharedByName,
				};
				stageRepositoryShareCapability(capability);
				setShareCapability(capability);
			})
			.catch(() => {
				if (disposed) return;
				clearRepositoryShareCapability();
				setShareCapability(null);
			});

		return () => {
			disposed = true;
		};
	}, [authClient, invite, resolved]);

	useEffect(() => {
		if (
			!resolved?.canEdit ||
			!repositoryState.isLoaded ||
			repositoryState.activeRepository?.repository.id === resolved.repositoryId
		) {
			return;
		}
		repositoryState.selectRepository(resolved.repositoryId);
	}, [resolved, repositoryState]);

	const joinToEdit = useCallback(async () => {
		if (!resolved || !shareCapability) {
			throw new Error("This share link is no longer available.");
		}
		if (!authUser) {
			requestRepositoryShareJoin(resolved.repositoryId);
			await signInWithGoogle(canonicalPathFromLocation(window.location));
			return;
		}
		if (!authClient) throw new Error("Authentication is still loading.");

		setJoining(true);
		try {
			const { error } = await authClient.rpc("accept_lix_share_token", {
				p_token: shareCapability.token,
			});
			if (error) throw error;
			takeRepositoryShareCapability();
			setShareCapability(null);
			setResolved((current) =>
				current && current.repositoryId === resolved.repositoryId
					? { ...current, canEdit: true }
					: current,
			);
			setAccessRevision((current) => current + 1);
			await repositoryState.refresh({ repositoryId: resolved.repositoryId });
			toast.success(
				`You joined ${resolved.repositoryName} — you can edit now.`,
			);
		} finally {
			setJoining(false);
		}
	}, [
		authClient,
		authUser,
		resolved,
		shareCapability,
		signInWithGoogle,
		repositoryState,
	]);

	// Local development sign-in does not pass through /auth/callback. The join
	// intent still requires an explicit earlier Join click and is consumed here.
	useEffect(() => {
		if (
			!authUser ||
			!shareCapability ||
			resolved?.canEdit ||
			peekRepositoryShareJoinIntent() !== shareCapability.repositoryId
		) {
			return;
		}
		if (automaticJoinAttempt.current === shareCapability.token) return;
		automaticJoinAttempt.current = shareCapability.token;
		takeRepositoryShareJoinIntent();
		void joinToEdit().catch((caught: unknown) => {
			toast.error(
				caught instanceof Error
					? caught.message
					: "Unable to join this repository.",
			);
		});
	}, [authUser, joinToEdit, resolved?.canEdit, shareCapability]);

	useEffect(() => {
		if (!resolved?.canEdit) return;
		if (takeRepositoryShareJoined(resolved.repositoryId)) {
			toast.success(
				`You joined ${resolved.repositoryName} — you can edit now.`,
			);
		}
	}, [resolved?.canEdit, resolved?.repositoryId, resolved?.repositoryName]);

	useEffect(() => {
		const joinError = takeRepositoryShareJoinError();
		if (joinError) toast.error(joinError);
	}, []);

	if (resolved === undefined) {
		return <RepositoryAccessScreen pathname={pathname} searchStr={searchStr} />;
	}
	if (shouldWaitForInviteResolution) {
		if (failedInviteKey === inviteResolutionKey) {
			return (
				<RepositoryRouteStatus>
					<strong>You joined, but edit access could not be refreshed.</strong>
					<Button variant="outline" onClick={() => setFailedInviteKey(null)}>
						Retry
					</Button>
				</RepositoryRouteStatus>
			);
		}
		return (
			<RepositoryRouteStatus>Opening shared repository…</RepositoryRouteStatus>
		);
	}
	if (resolveError) {
		return (
			<RepositoryAccessScreen
				pathname={pathname}
				searchStr={searchStr}
				status="error"
				onRetry={() => setAccessRevision((current) => current + 1)}
			/>
		);
	}
	if (!resolved) {
		return (
			<RepositoryAccessScreen
				pathname={pathname}
				searchStr={searchStr}
				status="unavailable"
				signedIn={Boolean(authUser)}
				onSignIn={() => {
					void signInWithGoogle(
						canonicalPathFromLocation(window.location),
					).catch((error: unknown) => {
						toast.error(
							error instanceof Error
								? error.message
								: "Unable to start sign-in.",
						);
					});
				}}
			/>
		);
	}
	if (
		!resolved.canEdit &&
		resolved.visibility === "private" &&
		shareCapability &&
		!resolved.pathPublic
	) {
		return (
			<RepositoryRouteStatus>
				<strong>
					{shareCapability.sharerName ?? "A repository member"} invited you to{" "}
					{resolved.repositoryName}
				</strong>
				<span>Join as a member to open and edit this private repository.</span>
				<Button
					disabled={joining}
					onClick={() =>
						void joinToEdit().catch((caught: unknown) => {
							toast.error(
								caught instanceof Error
									? caught.message
									: "Unable to join this repository.",
							);
						})
					}
				>
					{joining ? "Joining…" : "Join repository"}
				</Button>
			</RepositoryRouteStatus>
		);
	}
	if (
		!resolved.canEdit &&
		resolved.visibility === "private" &&
		resolved.pathPublic &&
		publishedResource
	) {
		return (
			<>
				<PublishedResourceView
					repositoryId={resolved.repositoryId}
					namespace={resolved.organizationHandle}
					repositorySlug={resolved.repositorySlug}
					repositoryName={resolved.repositoryName}
					resource={publishedResource}
				/>
				<Outlet />
			</>
		);
	}

	return (
		<RepositoryAtelier
			key={`${resolved.repositoryId}:${resolved.canEdit ? "edit" : "read"}`}
			repositoryId={resolved.repositoryId}
			namespaceId={resolved.organizationId}
			namespace={resolved.organizationHandle}
			repositorySlug={resolved.repositorySlug}
			repositoryName={resolved.repositoryName}
			repositoryVisibility={resolved.visibility}
			branchId={branch}
			canEdit={resolved.canEdit}
			publicPath={
				!resolved.canEdit && resolved.visibility === "private"
					? publicPath
					: undefined
			}
			shareAccess={
				shareCapability && !resolved.canEdit
					? { onJoinToEdit: joinToEdit, joining }
					: undefined
			}
		/>
	);
}

function publishedResourceFromRoute(
	pathname: string,
	namespace: string,
	repositorySlug: string,
): PublishedResource | undefined {
	const root = `/@${namespace}/${repositorySlug}`;
	for (const kind of ["file", "dir"] as const) {
		const prefix = `${root}/${kind}/`;
		if (!pathname.startsWith(prefix)) continue;
		try {
			return {
				kind: kind === "dir" ? "directory" : "file",
				path: `/${decodeURIComponent(pathname.slice(prefix.length))}`,
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function RepositoryRouteStatus({ children }: { children: ReactNode }) {
	return (
		<main className="grid min-h-[70vh] place-content-center justify-items-center gap-3.5 p-8 text-center text-text-secondary">
			{children}
		</main>
	);
}
