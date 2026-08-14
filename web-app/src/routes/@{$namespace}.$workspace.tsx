import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import { WorkspaceAtelier } from "~/components/workspace-atelier";
import { useWorkspace } from "~/components/workspace-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";
import {
	acceptTeamInviteForWorkspace,
	resolvePublicWorkspaceByRoute,
	resolveWorkspaceShareToken,
	TeamInviteAccessConfirmationError,
	type PublicWorkspaceRoute,
} from "~/lib/public-workspace";
import {
	clearWorkspaceShareCapability,
	isWorkspaceShareToken,
	peekWorkspaceShareCapability,
	peekWorkspaceShareJoinIntent,
	requestWorkspaceShareJoin,
	stageWorkspaceShareCapability,
	takeWorkspaceShareCapability,
	takeWorkspaceShareJoinError,
	takeWorkspaceShareJoinIntent,
	takeWorkspaceShareJoined,
	type PendingWorkspaceShareCapability,
} from "~/lib/workspace-share-capability";
import {
	isTeamInviteToken,
	peekTeamInvite,
	stageTeamInvite,
	stagedTeamInviteForRoute,
	takeTeamInvite,
} from "~/lib/team-invite";
import { canonicalPathFromLocation } from "~/lib/workspace-share-url";
import { findWorkspaceByRoute, normalizeDirPath } from "~/lib/workspace-url";

interface WorkspaceSearch {
	dir?: string;
	branch?: string;
	invite?: string;
}

export const Route = createFileRoute("/@{$namespace}/$workspace")({
	ssr: false,
	validateSearch: (search: Record<string, unknown>): WorkspaceSearch => {
		const dir = normalizeDirPath(search.dir);
		const branch =
			typeof search.branch === "string" && search.branch.trim().length > 0
				? search.branch.trim()
				: undefined;
		const invite = isWorkspaceShareToken(search.invite)
			? search.invite
			: undefined;
		return {
			...(dir === "/" ? {} : { dir }),
			...(branch ? { branch } : {}),
			...(invite ? { invite } : {}),
		};
	},
	component: WorkspaceRoutePage,
});

function WorkspaceRoutePage() {
	const { namespace, workspace: workspaceSlug } = Route.useParams();
	const { branch, invite } = Route.useSearch();
	const {
		client: authClient,
		isLoaded: authIsLoaded,
		signInWithGoogle,
		user: authUser,
	} = useAuth();
	const workspaceState = useWorkspace();
	const navigate = useNavigate();
	const demoResolved = useMemo(
		() =>
			findWorkspaceByRoute(
				workspaceState.organizations,
				namespace,
				workspaceSlug,
			),
		[namespace, workspaceSlug, workspaceState.organizations],
	);
	const demoCanEdit = isDemoModeEnabled && demoResolved !== null;
	const [resolved, setResolved] = useState<
		PublicWorkspaceRoute | null | undefined
	>(undefined);
	const [resolveError, setResolveError] = useState<string | null>(null);
	const [shareCapability, setShareCapability] =
		useState<PendingWorkspaceShareCapability | null>(null);
	const [joining, setJoining] = useState(false);
	const [accessRevision, setAccessRevision] = useState(0);
	const [settledInviteKey, setSettledInviteKey] = useState<string | null>(null);
	const [stagedTeamInvite, setStagedTeamInvite] = useState(peekTeamInvite);
	const [failedInviteKey, setFailedInviteKey] = useState<string | null>(null);
	const automaticJoinAttempt = useRef<string | null>(null);
	const resolvedWorkspaceId = resolved?.workspaceId;
	const urlTeamInvite = invite && isTeamInviteToken(invite) ? invite : null;
	const pendingTeamInvite =
		urlTeamInvite ??
		stagedTeamInviteForRoute(stagedTeamInvite, namespace, workspaceSlug);
	const inviteResolutionKey =
		resolvedWorkspaceId && pendingTeamInvite
			? `${resolvedWorkspaceId}:${pendingTeamInvite}`
			: resolvedWorkspaceId && invite
				? `${resolvedWorkspaceId}:${invite}`
				: null;
	const shouldWaitForInviteResolution =
		!isDemoModeEnabled &&
		inviteResolutionKey !== null &&
		settledInviteKey !== inviteResolutionKey;

	// Public route resolution is intentionally independent of the workspace
	// directory. A reader may have no organization membership at all.
	useEffect(() => {
		let disposed = false;
		setResolveError(null);
		setResolved(undefined);

		if (isDemoModeEnabled) {
			if (!authIsLoaded) return;
			setResolved(
				demoResolved
					? {
							organizationId: demoResolved.organization.id,
							organizationName: demoResolved.organization.name,
							organizationHandle: demoResolved.organization.handle,
							workspaceId: demoResolved.workspace.id,
							workspaceName: demoResolved.workspace.name,
							workspaceSlug: demoResolved.workspace.slug,
							canEdit: demoCanEdit,
						}
					: null,
			);
			return;
		}
		if (!authIsLoaded || !authClient) return;

		void resolvePublicWorkspaceByRoute(authClient, namespace, workspaceSlug)
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
		namespace,
		workspaceSlug,
	]);

	const cleanInviteFromAddressBar = useCallback(() => {
		void navigate({
			to: ".",
			search: (previous) => {
				const canonicalSearch = { ...(previous as WorkspaceSearch) };
				delete canonicalSearch.invite;
				return canonicalSearch;
			},
			hash: true,
			replace: true,
			resetScroll: false,
		});
	}, [navigate]);

	// A team invite (tm_…) joins the workspace's namespace. Keep the Atelier
	// closed until the invite has been accepted and a fresh route lookup confirms
	// edit access. Otherwise the public route can mount a read-only Lix while the
	// membership update is still in flight.
	useEffect(() => {
		if (
			isDemoModeEnabled ||
			!resolvedWorkspaceId ||
			!authClient ||
			!pendingTeamInvite ||
			!authIsLoaded
		) {
			return;
		}
		const inviteKey = `${resolvedWorkspaceId}:${pendingTeamInvite}`;
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
				workspaceSlug,
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
				const joined = await acceptTeamInviteForWorkspace(
					authClient,
					pendingTeamInvite,
					namespace,
					workspaceSlug,
					resolvedWorkspaceId,
				);
				if (disposed) return;
				setResolved(joined.workspace);
				toast.success(
					joined.joinedNamespaceName
						? `You joined ${joined.joinedNamespaceName} — every repository, edit access.`
						: "You joined the team.",
				);
				settle(true);
				void workspaceState.refresh({ workspaceId: resolvedWorkspaceId });
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
		resolvedWorkspaceId,
		settledInviteKey,
		urlTeamInvite,
		workspaceSlug,
		workspaceState,
	]);

	// A capability is resolved once, held only for this browser session, then
	// removed from router state and the address bar. Invalid/revoked links clean
	// to the same public read page instead of becoming a dead end.
	useEffect(() => {
		if (
			isDemoModeEnabled ||
			!resolvedWorkspaceId ||
			!authClient ||
			!invite ||
			isTeamInviteToken(invite)
		)
			return;
		let disposed = false;
		void resolveWorkspaceShareToken(authClient, invite)
			.then((candidate) => {
				if (disposed) return;
				if (
					candidate &&
					candidate.grantsEdit &&
					candidate.workspaceId === resolvedWorkspaceId
				) {
					const capability = {
						token: invite,
						workspaceId: candidate.workspaceId,
						sharerName: candidate.sharedByName,
					};
					stageWorkspaceShareCapability(capability);
					// Render token-derived UI only after the canonical URL has been
					// reached and the session-held capability is checked again.
					setShareCapability(null);
				} else {
					clearWorkspaceShareCapability();
					setShareCapability(null);
				}
			})
			.catch(() => {
				if (disposed) return;
				clearWorkspaceShareCapability();
				setShareCapability(null);
				toast.error("Unable to validate this share link.");
			})
			.finally(() => {
				if (!disposed) {
					setSettledInviteKey(`${resolvedWorkspaceId}:${invite}`);
					cleanInviteFromAddressBar();
				}
			});
		return () => {
			disposed = true;
		};
	}, [authClient, cleanInviteFromAddressBar, invite, resolvedWorkspaceId]);

	// Validation deliberately drops malformed tokens from router search. Clean a
	// raw malformed `invite` parameter too, so it cannot survive in history or
	// reappear on a later in-app navigation.
	useEffect(() => {
		if (resolved === undefined || invite || typeof window === "undefined") {
			return;
		}
		const rawInvite = new URLSearchParams(window.location.search).get("invite");
		if (!rawInvite || isWorkspaceShareToken(rawInvite)) return;
		clearWorkspaceShareCapability();
		setShareCapability(null);
		cleanInviteFromAddressBar();
	}, [cleanInviteFromAddressBar, invite, resolved]);

	// After canonicalization, re-check the session-held capability. This keeps a
	// revoked link on the plain public page even after its token left the URL.
	useEffect(() => {
		if (!resolved || invite) return;
		if (isDemoModeEnabled) {
			clearWorkspaceShareCapability();
			setShareCapability(null);
			return;
		}
		if (!authClient) return;
		const staged = peekWorkspaceShareCapability();
		if (
			!staged ||
			staged.workspaceId !== resolved.workspaceId ||
			resolved.canEdit
		) {
			if (resolved.canEdit) clearWorkspaceShareCapability();
			setShareCapability(null);
			return;
		}

		let disposed = false;
		setShareCapability(null);
		void resolveWorkspaceShareToken(authClient, staged.token)
			.then((candidate) => {
				if (disposed) return;
				if (
					!candidate ||
					!candidate.grantsEdit ||
					candidate.workspaceId !== resolved.workspaceId
				) {
					clearWorkspaceShareCapability();
					setShareCapability(null);
					return;
				}
				const capability = {
					token: staged.token,
					workspaceId: candidate.workspaceId,
					sharerName: candidate.sharedByName,
				};
				stageWorkspaceShareCapability(capability);
				setShareCapability(capability);
			})
			.catch(() => {
				if (disposed) return;
				clearWorkspaceShareCapability();
				setShareCapability(null);
			});

		return () => {
			disposed = true;
		};
	}, [authClient, invite, resolved]);

	useEffect(() => {
		if (
			!resolved?.canEdit ||
			!workspaceState.isLoaded ||
			workspaceState.activeWorkspace?.workspace.id === resolved.workspaceId
		) {
			return;
		}
		workspaceState.selectWorkspace(resolved.workspaceId);
	}, [resolved, workspaceState]);

	const joinToEdit = useCallback(async () => {
		if (!resolved || !shareCapability) {
			throw new Error("This share link is no longer available.");
		}
		if (!authUser) {
			requestWorkspaceShareJoin(resolved.workspaceId);
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
			takeWorkspaceShareCapability();
			setShareCapability(null);
			setResolved((current) =>
				current && current.workspaceId === resolved.workspaceId
					? { ...current, canEdit: true }
					: current,
			);
			setAccessRevision((current) => current + 1);
			await workspaceState.refresh({ workspaceId: resolved.workspaceId });
			toast.success(`You joined ${resolved.workspaceName} — you can edit now.`);
		} finally {
			setJoining(false);
		}
	}, [
		authClient,
		authUser,
		resolved,
		shareCapability,
		signInWithGoogle,
		workspaceState,
	]);

	// Local development sign-in does not pass through /auth/callback. The join
	// intent still requires an explicit earlier Join click and is consumed here.
	useEffect(() => {
		if (
			!authUser ||
			!shareCapability ||
			resolved?.canEdit ||
			peekWorkspaceShareJoinIntent() !== shareCapability.workspaceId
		) {
			return;
		}
		if (automaticJoinAttempt.current === shareCapability.token) return;
		automaticJoinAttempt.current = shareCapability.token;
		takeWorkspaceShareJoinIntent();
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
		if (takeWorkspaceShareJoined(resolved.workspaceId)) {
			toast.success(`You joined ${resolved.workspaceName} — you can edit now.`);
		}
	}, [resolved?.canEdit, resolved?.workspaceId, resolved?.workspaceName]);

	useEffect(() => {
		const joinError = takeWorkspaceShareJoinError();
		if (joinError) toast.error(joinError);
	}, []);

	if (resolved === undefined) {
		return <WorkspaceRouteStatus>Opening repository…</WorkspaceRouteStatus>;
	}
	if (shouldWaitForInviteResolution) {
		if (failedInviteKey === inviteResolutionKey) {
			return (
				<WorkspaceRouteStatus>
					<strong>You joined, but edit access could not be refreshed.</strong>
					<Button variant="outline" onClick={() => setFailedInviteKey(null)}>
						Retry
					</Button>
				</WorkspaceRouteStatus>
			);
		}
		return (
			<WorkspaceRouteStatus>Opening shared repository…</WorkspaceRouteStatus>
		);
	}
	if (resolveError) {
		return <WorkspaceRouteStatus>{resolveError}</WorkspaceRouteStatus>;
	}
	if (!resolved) {
		return (
			<WorkspaceRouteStatus>
				<strong>Repository not found</strong>
				<Button asChild variant="outline">
					<Link to="/home">Back to repositories</Link>
				</Button>
			</WorkspaceRouteStatus>
		);
	}

	return (
		<WorkspaceAtelier
			key={`${resolved.workspaceId}:${resolved.canEdit ? "edit" : "read"}`}
			workspaceId={resolved.workspaceId}
			namespaceId={resolved.organizationId}
			namespace={resolved.organizationHandle}
			workspaceSlug={resolved.workspaceSlug}
			workspaceName={resolved.workspaceName}
			branchId={branch}
			canEdit={resolved.canEdit}
			shareAccess={
				shareCapability && !resolved.canEdit
					? { onJoinToEdit: joinToEdit, joining }
					: undefined
			}
		/>
	);
}

function WorkspaceRouteStatus({ children }: { children: ReactNode }) {
	return (
		<main className="grid min-h-[70vh] place-content-center justify-items-center gap-3.5 p-8 text-center text-text-secondary">
			{children}
		</main>
	);
}
