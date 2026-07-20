import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthProvider } from "~/components/auth-provider";
import { PostHogAnalytics } from "~/components/posthog-analytics";
import { Toaster } from "~/components/ui/sonner";
import { WorkspaceProvider } from "~/components/workspace-provider";
import appCss from "../styles.css?url";

const title = "LixRay — One workspace for your team and AI agents";
const description =
	"A shared workspace where your team and AI agents work from the same files, context, and change history.";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title },
			{ name: "description", content: description },
			{ name: "theme-color", content: "#fbf6f0" },
			{ name: "referrer", content: "no-referrer" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/lixray-mark.svg", type: "image/svg+xml" },
			{ rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
			{ rel: "manifest", href: "/manifest.webmanifest" },
		],
	}),
	component: Outlet,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<AuthProvider>
					<WorkspaceProvider>
						<PostHogAnalytics />
						{children}
					</WorkspaceProvider>
				</AuthProvider>
				<Toaster />
				<Scripts />
			</body>
		</html>
	);
}
