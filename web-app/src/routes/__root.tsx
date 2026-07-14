import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthProvider } from "~/components/auth-provider";
import { Toaster } from "~/components/ui/sonner";
import { WorkspaceProvider } from "~/components/workspace-provider";
import appCss from "../styles.css?url";

const title = "LixRay";
const description = "Workspace-scoped Lix over HTTP, backed by SlateDB on R2.";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title },
			{ name: "description", content: description },
			{ name: "theme-color", content: "#f4f2ef" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/lixray-mark.svg", type: "image/svg+xml" },
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
					<WorkspaceProvider>{children}</WorkspaceProvider>
				</AuthProvider>
				<Toaster />
				<Scripts />
			</body>
		</html>
	);
}
