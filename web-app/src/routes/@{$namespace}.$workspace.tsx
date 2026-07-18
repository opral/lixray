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
import { normalizeDirPath } from "~/lib/file-explorer-api";
import {
	resolvePublicWorkspaceByRoute,
	resolveWorkspaceShareToken,
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
import { canonicalPathFromLocation } from "~/lib/workspace-share-url";
import { findWorkspaceByRoute } from "~/lib/workspace-url";

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
	const { client: authClient, signInWithGoogle, user: authUser } = useAuth();
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
	const [resolved, setResolved] = useState<
		PublicWorkspaceRoute | null | undefined
	>(undefined);
	const [resolveError, setResolveError] = useState<string | null>(null);
	const [shareCapability, setShareCapability] =
		useState<PendingWorkspaceShareCapability | null>(null);
	const [joining, setJoining] = useState(false);
	const [accessRevision, setAccessRevision] = useState(0);
	const [settledInviteKey, setSettledInviteKey] = useState<string | null>(null);
	const automaticJoinAttempt = useRef<string | null>(null);
	const inviteResolutionKey =
		resolved && invite ? `${resolved.workspaceId}:${invite}` : null;
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
			setResolved(
				demoResolved
					? {
							organizationId: demoResolved.organization.id,
							organizationName: demoResolved.organization.name,
							organizationHandle: demoResolved.organization.handle,
							workspaceId: demoResolved.workspace.id,
							workspaceName: demoResolved.workspace.name,
							workspaceSlug: demoResolved.workspace.slug,
							canEdit: true,
						}
					: null,
			);
			return;
		}
		if (!authClient) return;

		void resolvePublicWorkspaceByRoute(authClient, namespace, workspaceSlug)
			.then((nextResolved) => {
				if (!disposed) setResolved(nextResolved);
			})
			.catch((caught: unknown) => {
				if (disposed) return;
				setResolveError(
					caught instanceof Error
						? caught.message
						: "Unable to open workspace.",
				);
				setResolved(null);
			});

		return () => {
			disposed = true;
		};
	}, [
		accessRevision,
		authClient,
		authUser?.id,
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

	// Demo mode has no share-token database. Keep its existing editing demo
	// usable if a copied capability URL is pasted into it, but never pretend the
	// opaque token was accepted there.
	useEffect(() => {
		if (!isDemoModeEnabled || !invite) return;
		clearWorkspaceShareCapability();
		setShareCapability(null);
		cleanInviteFromAddressBar();
	}, [cleanInviteFromAddressBar, invite]);

	// A capability is resolved once, held only for this browser session, then
	// removed from router state and the address bar. Invalid/revoked links clean
	// to the same public read page instead of becoming a dead end.
	useEffect(() => {
		if (!resolved || !authClient || !invite) return;
		let disposed = false;
		void resolveWorkspaceShareToken(authClient, invite)
			.then((candidate) => {
				if (disposed) return;
				if (
					candidate &&
					candidate.grantsEdit &&
					candidate.workspaceId === resolved.workspaceId
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
					setSettledInviteKey(`${resolved.workspaceId}:${invite}`);
					cleanInviteFromAddressBar();
				}
			});
		return () => {
			disposed = true;
		};
	}, [authClient, cleanInviteFromAddressBar, invite, resolved]);

	// Validation deliberately drops malformed tokens from router search. Clean a
	// raw malformed `invite` parameter too, so it cannot survive in history or
	// reappear on a later in-app navigation.
	useEffect(() => {
		if (resolved === undefined || invite || typeof window === "undefined") {
			return;
		}
		if (!new URLSearchParams(window.location.search).has("invite")) return;
		clearWorkspaceShareCapability();
		setShareCapability(null);
		cleanInviteFromAddressBar();
	}, [cleanInviteFromAddressBar, invite, resolved]);

	// After canonicalization, re-check the session-held capability. This keeps a
	// revoked link on the plain public page even after its token left the URL.
	useEffect(() => {
		if (!resolved || invite || !authClient) return;
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
			const { error } = await authClient.rpc("accept_workspace_share_token", {
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
					: "Unable to join this workspace.",
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
		return <WorkspaceRouteStatus>Opening workspace…</WorkspaceRouteStatus>;
	}
	if (shouldWaitForInviteResolution) {
		return (
			<WorkspaceRouteStatus>Opening shared workspace…</WorkspaceRouteStatus>
		);
	}
	if (resolveError) {
		return <WorkspaceRouteStatus>{resolveError}</WorkspaceRouteStatus>;
	}
	if (!resolved) {
		return (
			<WorkspaceRouteStatus>
				<strong>Workspace not found</strong>
				<Button asChild variant="outline">
					<Link to="/home">Back to workspaces</Link>
				</Button>
			</WorkspaceRouteStatus>
		);
	}

	return (
		<WorkspaceAtelier
			key={`${resolved.workspaceId}:${resolved.canEdit ? "edit" : "read"}`}
			workspaceId={resolved.workspaceId}
			namespace={resolved.organizationHandle}
			workspaceSlug={resolved.workspaceSlug}
			workspaceName={resolved.workspaceName}
			branchId={branch}
			canEdit={resolved.canEdit}
			shareAccess={
				shareCapability && !resolved.canEdit
					? {
							sharedByName: shareCapability.sharerName,
							onJoinToEdit: joinToEdit,
							joining,
						}
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
