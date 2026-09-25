import { readRepositoryRoute } from "~/lib/repository-route-lifecycle";
import {
	canonicalConversationSplat,
	parseEntityUrlSplat,
} from "~/lib/entity-url";
import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import {
	ATELIER_CONVERSATION_VIEW_ID,
	selectConversationSummary,
} from "@opral/atelier";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
	useBeginRepositoryRouteNavigation,
	useConsumeShellEntityNavigation,
	useMarkRepositoryRouteSynced,
	useRepositoryActiveBranchId,
	useRepositoryAtelierInstance,
	useRepositoryDefaultBranchId,
} from "~/components/repository-atelier";
import {
	atelierBranchSearch,
	conversationSlugText,
} from "~/lib/atelier-navigation";

export const Route = createFileRoute(
	"/@{$namespace}/$repository/conversation/$",
)({
	head: ({ params, match }) =>
		repositoryHead(params, "conversation", match.search),
	beforeLoad: ({ params }) => {
		if (!parseEntityUrlSplat(params._splat)) notFound({ throw: true });
	},
	component: RepositoryConversationRoute,
});

/**
 * A conversation URL opens Atelier's conversation view in its own tab (one
 * tab per conversation). The token resolves; the trailing title slug is
 * decoration, rewritten from the conversation's current name. A missing or
 * inaccessible conversation still opens the view, which says so in-tab.
 */
function RepositoryConversationRoute() {
	const atelier = useRepositoryAtelierInstance();
	const defaultBranchId = useRepositoryDefaultBranchId();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const beginRouteNavigation = useBeginRepositoryRouteNavigation();
	const consumeShellNavigation = useConsumeShellEntityNavigation();
	const navigate = useNavigate();
	const { namespace, repository, _splat: splat } = Route.useParams();
	const conversationId = parseEntityUrlSplat(splat)?.id;
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();
	// Read, not a dependency: rewriting the slug must not reopen the view.
	const splatRef = useRef(splat);
	useLayoutEffect(() => {
		splatRef.current = splat;
	}, [splat]);

	useEffect(() => {
		if (!atelier || !conversationId) return;
		if (activeBranchId !== (branch ?? defaultBranchId)) return;
		if (consumeShellNavigation(`conversation:${conversationId}`)) {
			markRouteSynced();
			return;
		}
		const controller = beginRouteNavigation();
		const search =
			branch && defaultBranchId
				? atelierBranchSearch(branch, defaultBranchId)
				: {};

		// The name only decorates the URL; a failed lookup leaves it as linked.
		void readRepositoryRoute(controller.signal, () =>
			selectConversationSummary(atelier.lix, conversationId),
		)
			.then((summary) => {
				if (controller.signal.aborted || !summary) return;
				const canonical = canonicalConversationSplat(splatRef.current, {
					id: conversationId,
					title: conversationSlugText(summary),
				});
				if (canonical)
					void navigate({
						to: "/@{$namespace}/$repository/conversation/$",
						params: { namespace, repository, _splat: canonical },
						search,
						replace: true,
					});
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted)
					console.error("Unable to read the linked conversation", error);
			});

		// "Shell unmounted" is a transient of the dev double-mount (and HMR):
		// the shell remounts on the same instance, so the open is retried.
		const attempt = (retriesLeft: number) => {
			atelier.views
				.open(ATELIER_CONVERSATION_VIEW_ID, {
					state: { conversationId },
					newTab: true,
					signal: controller.signal,
				})
				.then(() => {
					if (!controller.signal.aborted) markRouteSynced();
				})
				.catch((error: unknown) => {
					if (controller.signal.aborted) return;
					if (
						error instanceof Error &&
						error.message.includes("shell unmounted") &&
						retriesLeft > 0
					) {
						setTimeout(() => {
							if (!controller.signal.aborted) attempt(retriesLeft - 1);
						}, 150);
						return;
					}
					console.error("Unable to open the requested conversation", error);
					// Synced even on failure: tab activations should drive the URL
					// again rather than staying frozen at a dead deep link.
					markRouteSynced();
				});
		};
		attempt(5);
		return () => {
			controller.abort();
		};
	}, [
		activeBranchId,
		atelier,
		beginRouteNavigation,
		branch,
		consumeShellNavigation,
		conversationId,
		defaultBranchId,
		markRouteSynced,
		namespace,
		navigate,
		repository,
	]);

	return null;
}
