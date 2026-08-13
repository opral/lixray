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

const title = "LixRay — A repository for your entire company";
const description =
	"One repo your team and your agents share. Any file type, every change tracked.";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title },
			{ name: "description", content: description },
			{ name: "theme-color", content: "#f4f2ef" },
			{ name: "referrer", content: "no-referrer" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{
				rel: "icon",
				href: "/favicon-32.png",
				type: "image/png",
				sizes: "32x32",
			},
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
