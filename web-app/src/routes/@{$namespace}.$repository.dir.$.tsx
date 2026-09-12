import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Folders moved from /dir to /folder. Links written before that — copied,
 * pasted into a document, or handed out by an agent — still open: the id is
 * carried across and the folder route rewrites the path from it.
 */
export const Route = createFileRoute("/@{$namespace}/$repository/dir/$")({
	beforeLoad: ({ params, search }) => {
		// TanStack signals a redirect by throwing its descriptor, which is not
		// an Error.
		// eslint-disable-next-line @typescript-eslint/only-throw-error
		throw redirect({
			to: "/@{$namespace}/$repository/folder/$",
			params,
			search,
			replace: true,
		});
	},
});
